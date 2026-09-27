// Content script in the Netflix tab (isolated world). Relays commands from the
// service worker to page.ts and streams the tab's state back while a phone is connected.

import type { CatalogCommand, CommandResult, PlayerCommand, PlayerState } from '../../shared/protocol';
import type { ContentMsg, PageCall, PageRequest, PageResponse, SwMsg, TabState } from './messages';
import { runCatalogCommand } from './netflix/catalog';
import { detectPageKind } from './netflix/page-kind';

const STATE_INTERVAL_MS = 1000;
const PAGE_TIMEOUT_MS = 2000;

const w = window as Window & { __nfrContent?: boolean };
if (!w.__nfrContent) {
    w.__nfrContent = true;
    init();
}

function init() {
    let nextId = 1;
    const pending = new Map<number, (r: PageResponse['result']) => void>();
    let timer: ReturnType<typeof setInterval> | undefined;

    window.addEventListener('message', (e: MessageEvent<PageResponse>) => {
        if (e.source !== window || e.data?.__nfr !== 'res') return;
        pending.get(e.data.id)?.(e.data.result);
        pending.delete(e.data.id);
    });

    function askPage(req: PageCall): Promise<PageResponse['result'] | undefined> {
        const id = nextId++;
        return new Promise((resolve) => {
            pending.set(id, resolve);
            const msg: PageRequest = { ...req, __nfr: 'req', id };
            window.postMessage(msg, window.location.origin);
            setTimeout(() => {
                if (pending.delete(id)) resolve(undefined);
            }, PAGE_TIMEOUT_MS);
        });
    }

    function toSw(msg: SwMsg): Promise<any> {
        return chrome.runtime.sendMessage(msg);
    }

    async function collectState(): Promise<TabState> {
        const page = detectPageKind(window.location, document);
        const player = page === 'watch' ? ((await askPage({ kind: 'state' })) as PlayerState | null | undefined) : null;
        return { page, location: window.location.pathname + window.location.search, player: player ?? null };
    }

    async function pushState() {
        try {
            await toSw({ target: 'sw', type: 'state', state: await collectState() });
        } catch {
            // Extension was reloaded or updated: this content script is orphaned.
            setStreaming(false);
        }
    }

    function setStreaming(on: boolean) {
        clearInterval(timer);
        timer = undefined;
        if (on) {
            timer = setInterval(pushState, STATE_INTERVAL_MS);
            void pushState();
        }
    }

    async function runCommand(cmd: PlayerCommand | CatalogCommand): Promise<CommandResult> {
        // The catalog is plain DOM work; the player needs Netflix's own API in the page world.
        const result = cmd.type.startsWith('catalog.')
            ? await runCatalogCommand(document, cmd as CatalogCommand).catch((e) => ({ ok: false, error: String(e) }))
            : ((await askPage({ kind: 'command', cmd: cmd as PlayerCommand })) as CommandResult | undefined);
        if (cmd.type !== 'catalog.get') setTimeout(pushState, 300);
        return result ?? { ok: false, error: 'Netflix-Seite antwortet nicht – bitte neu laden' };
    }

    chrome.runtime.onMessage.addListener((msg: ContentMsg, _sender, sendResponse) => {
        if (msg?.target !== 'content') return;
        switch (msg.type) {
            case 'command':
                runCommand(msg.cmd).then(sendResponse);
                return true;
            case 'streaming':
                setStreaming(msg.on);
                break;
            case 'pushState':
                void pushState();
                break;
        }
    });

    toSw({ target: 'sw', type: 'contentHello' })
        .then((r: { streaming: boolean } | undefined) => setStreaming(!!r?.streaming))
        .catch(() => {});
}
