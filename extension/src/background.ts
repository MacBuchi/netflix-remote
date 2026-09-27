// Service worker: owns config, keeps the offscreen WebRTC document alive, and
// routes commands from phones to the Netflix tab (or handles tab/window commands itself).

import { randomId, type Command, type CommandResult, type RemoteState } from '../../shared/protocol';
import { DEFAULT_REMOTE_URL, type Config, type ContentMsg, type OffscreenMsg, type SwMsg, type TabState } from './messages';

const NETFLIX_TABS = 'https://www.netflix.com/*';
const NETFLIX_BROWSE = 'https://www.netflix.com/browse';

// ---- config ----------------------------------------------------------------

async function getConfig(): Promise<Config> {
    const { config } = (await chrome.storage.local.get('config')) as { config?: Partial<Config> };
    const full: Config = {
        peerId: `nfr-${randomId(12)}`,
        key: randomId(16),
        pcName: 'Netflix-PC',
        broker: '',
        remoteUrl: DEFAULT_REMOTE_URL,
        ...config,
    };
    if (!config?.peerId || !config.key) await chrome.storage.local.set({ config: full });
    return full;
}

let saving: Promise<unknown> = Promise.resolve();

/** Saves are queued so two quick edits in the popup can't overwrite each other. */
function saveConfig(patch: Partial<Config>): Promise<Config> {
    const next = saving.then(async () => {
        const config = { ...(await getConfig()), ...patch };
        await chrome.storage.local.set({ config });
        await restartOffscreen();
        return config;
    });
    saving = next.catch(() => {});
    return next;
}

// ---- offscreen document (WebRTC) --------------------------------------------

let creating: Promise<void> | null = null;

async function ensureOffscreen() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (contexts.length) return;
    creating ??= chrome.offscreen
        .createDocument({
            url: 'offscreen.html',
            reasons: [chrome.offscreen.Reason.WEB_RTC],
            justification: 'Keeps the WebRTC connection to the phone remote open.',
        })
        .finally(() => (creating = null));
    await creating;
}

async function restartOffscreen() {
    await chrome.offscreen.closeDocument().catch(() => {});
    await setClients(0);
    await ensureOffscreen();
}

function toOffscreen(msg: OffscreenMsg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- Netflix tab ------------------------------------------------------------

async function netflixTabs(): Promise<chrome.tabs.Tab[]> {
    return chrome.tabs.query({ url: NETFLIX_TABS });
}

/** The Netflix tab the remote controls: the one used most recently. */
async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
    const tabs = await netflixTabs();
    return tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

async function focusTab(tab: chrome.tabs.Tab) {
    await chrome.tabs.update(tab.id!, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
}

async function injectContentScripts(tabId: number) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'], world: 'MAIN' });
}

async function toContent<T>(tabId: number, msg: ContentMsg): Promise<T> {
    try {
        return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
        // Tab was open before the extension was installed/updated: inject and retry once.
        await injectContentScripts(tabId);
        return await chrome.tabs.sendMessage(tabId, msg);
    }
}

// ---- state streaming ----------------------------------------------------------

async function getClients(): Promise<number> {
    const { clients } = (await chrome.storage.session.get('clients')) as { clients?: number };
    return clients ?? 0;
}

async function setClients(count: number) {
    await chrome.storage.session.set({ clients: count });
    const on = count > 0;
    for (const tab of await netflixTabs()) {
        chrome.tabs.sendMessage(tab.id!, { target: 'content', type: 'streaming', on } satisfies ContentMsg).catch(() => {});
    }
}

async function forwardState(tab: chrome.tabs.Tab, tabState: TabState) {
    const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
    const state: RemoteState = { ...tabState, fullscreen: win?.state === 'fullscreen' };
    toOffscreen({ target: 'offscreen', type: 'state', state });
}

async function refreshState() {
    if ((await getClients()) === 0) return;
    const tab = await targetTab();
    if (!tab?.id) {
        toOffscreen({ target: 'offscreen', type: 'state', state: { page: 'none', fullscreen: false, player: null } });
        return;
    }
    await toContent(tab.id, { target: 'content', type: 'pushState' }).catch(() =>
        forwardState(tab, { page: 'other', player: null }),
    );
}

// ---- commands -----------------------------------------------------------------

async function handleCommand(cmd: Command): Promise<CommandResult> {
    const tab = await targetTab();
    switch (cmd.type) {
        case 'app.openNetflix':
            if (tab) await focusTab(tab);
            else await chrome.tabs.create({ url: NETFLIX_BROWSE });
            return { ok: true };
        case 'app.browse':
            if (tab?.id) await chrome.tabs.update(tab.id, { url: NETFLIX_BROWSE });
            else await chrome.tabs.create({ url: NETFLIX_BROWSE });
            return { ok: true };
        case 'app.fullscreen':
            if (!tab) return { ok: false, error: 'Netflix ist nicht geöffnet' };
            await setFullscreen(tab, cmd.on);
            return { ok: true };
        default:
            if (!tab?.id) return { ok: false, error: 'Netflix ist nicht geöffnet' };
            try {
                return await toContent<CommandResult>(tab.id, { target: 'content', type: 'command', cmd });
            } catch {
                return { ok: false, error: 'Netflix-Tab reagiert nicht – bitte Seite neu laden' };
            }
    }
}

/**
 * Real element fullscreen needs a user gesture on the PC, which a remote can't provide.
 * A fullscreen browser window looks the same because Netflix fills the viewport.
 */
async function setFullscreen(tab: chrome.tabs.Tab, on: boolean) {
    const win = await chrome.windows.get(tab.windowId);
    if (on && win.state !== 'fullscreen') {
        await chrome.storage.session.set({ [`prevState${win.id}`]: win.state });
        await chrome.tabs.update(tab.id!, { active: true });
        await chrome.windows.update(win.id!, { state: 'fullscreen', focused: true });
    } else if (!on && win.state === 'fullscreen') {
        const key = `prevState${win.id}`;
        const prev = ((await chrome.storage.session.get(key)) as Record<string, chrome.windows.WindowState>)[key];
        await chrome.windows.update(win.id!, { state: prev && prev !== 'fullscreen' ? prev : 'normal' });
    }
}

// ---- wiring ----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: SwMsg, sender, sendResponse) => {
    if (msg?.target !== 'sw') return;
    const reply = (p: Promise<unknown>) => {
        p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
        return true;
    };
    switch (msg.type) {
        case 'getConfig':
            return reply(getConfig());
        case 'updateConfig':
            return reply(saveConfig(msg.patch));
        case 'resetPairing':
            return reply(saveConfig({ key: randomId(16) }));
        case 'command':
            return reply(handleCommand(msg.cmd).then(async (r) => (await refreshState(), r)));
        case 'clients':
            return reply(setClients(msg.count).then(refreshState));
        case 'contentHello':
            return reply(getClients().then((n) => ({ streaming: n > 0 })));
        case 'state':
            return reply(
                targetTab().then((tab) => {
                    if (tab && sender.tab?.id === tab.id) return forwardState(tab, msg.state);
                }),
            );
    }
});

chrome.tabs.onRemoved.addListener(() => void refreshState());
chrome.tabs.onActivated.addListener(() => void refreshState());
chrome.windows.onBoundsChanged.addListener(() => void refreshState());

chrome.runtime.onInstalled.addListener(async () => {
    for (const tab of await netflixTabs()) {
        if (tab.id) await injectContentScripts(tab.id).catch(() => {});
    }
});
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void ensureOffscreen());
void ensureOffscreen();
