// Reads the film browser from the Netflix page and performs catalog actions.
// Runs in the content script; plain DOM work, no Netflix internals.
//
// Netflix changes its markup often, so scraping keys on what must stay stable
// for the site to work: links to /watch/<id>, /title/<id> or ?jbv=<id>, their
// aria-labels and images. Rows are the nearest row-like ancestor with a heading.

import type {
    Catalog,
    CatalogCommand,
    CatalogItem,
    CatalogRow,
    CommandResult,
    Episode,
    Profile,
    TitleDetail,
} from '../../../shared/protocol';
import { SECTION_URLS } from '../../../shared/protocol';
import { detectPageKind } from './page-kind';
import { SEL } from './selectors';

const MAX_ITEMS_PER_ROW = 30;
const GENERIC_LINK_TEXT = /^(play|abspielen|wiedergabe|more info|weitere infos|mehr infos|resume|fortsetzen)$/i;

type Sel = string | readonly string[];

function q<T extends Element = HTMLElement>(root: ParentNode, sel: Sel): T | null {
    for (const s of typeof sel === 'string' ? [sel] : sel) {
        const el = root.querySelector<T>(s);
        if (el) return el;
    }
    return null;
}

function qa<T extends Element = HTMLElement>(root: ParentNode, sel: Sel): T[] {
    for (const s of typeof sel === 'string' ? [sel] : sel) {
        const els = root.querySelectorAll<T>(s);
        if (els.length) return Array.from(els);
    }
    return [];
}

function closest(el: Element, sel: Sel): HTMLElement | null {
    for (const s of typeof sel === 'string' ? [sel] : sel) {
        const found = el.closest<HTMLElement>(s);
        if (found) return found;
    }
    return null;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

export function videoIdFromHref(href: string | null): string | null {
    if (!href) return null;
    return href.match(/\/(?:watch|title)\/(\d+)/)?.[1] ?? href.match(/[?&]jbv=(\d+)/)?.[1] ?? null;
}

function imageOf(root: Element | null): string | null {
    if (!root) return null;
    const img = root.querySelector('img');
    const src = img?.currentSrc || img?.getAttribute('src') || img?.getAttribute('data-src');
    if (src && !src.startsWith('data:')) return new URL(src, location.href).href;
    const bg = (root instanceof HTMLElement ? root : null)?.style.backgroundImage.match(/url\(["']?([^"')]+)/)?.[1];
    return bg ? new URL(bg, location.href).href : null;
}

function progressOf(root: Element | null): number | null {
    const el = root && q(root, SEL.progress);
    if (!el) return null;
    if (el instanceof HTMLProgressElement) return el.max ? el.value / el.max : null;
    const width = parseFloat(el.style.width);
    return Number.isFinite(width) ? Math.min(1, Math.max(0, width / 100)) : null;
}

function detailRoot(doc: Document): HTMLElement | null {
    return q(doc, SEL.detail);
}

// ---- reading ---------------------------------------------------------------------

function readRows(doc: Document): CatalogRow[] {
    const modal = detailRoot(doc);
    const rows = new Map<Element | null, CatalogRow & { seen: Set<string> }>();

    for (const a of doc.querySelectorAll<HTMLAnchorElement>(SEL.titleLinks)) {
        if (modal?.contains(a) || closest(a, SEL.billboard)) continue;
        const id = videoIdFromHref(a.getAttribute('href'));
        if (!id) continue;
        const card = closest(a, SEL.card) ?? a;
        const name =
            a.getAttribute('aria-label')?.trim() ||
            text(q(card, SEL.cardName)) ||
            card.querySelector('img')?.getAttribute('alt')?.trim() ||
            text(a);
        if (!name || GENERIC_LINK_TEXT.test(name)) continue;

        const rowEl = closest(card, SEL.row);
        let row = rows.get(rowEl);
        if (!row) {
            const title = rowEl ? text(q(rowEl, SEL.rowTitle)) || rowEl.getAttribute('aria-label') || '' : '';
            row = { title, items: [], seen: new Set() };
            rows.set(rowEl, row);
        }
        if (row.seen.has(id) || row.items.length >= MAX_ITEMS_PER_ROW) continue;
        row.seen.add(id);
        const item: CatalogItem = { id, name, img: imageOf(card), progress: progressOf(card) };
        row.items.push(item);
    }
    return [...rows.values()].map(({ title, items }) => ({ title, items }));
}

/** Profile links of the gate, not the switcher in the header menu. */
function profileLinks(doc: Document): HTMLElement[] {
    return qa(doc, SEL.profileLink).filter((el) => !el.closest(SEL.headerMenus));
}

function readProfiles(doc: Document): Profile[] {
    return profileLinks(doc).map((el, index) => ({
        index,
        name: text(q(el, SEL.profileName)) || el.getAttribute('aria-label') || text(el),
        img: imageOf(q(el, SEL.profileImage) ?? el),
    }));
}

function readDetail(doc: Document): TitleDetail | null {
    const modal = detailRoot(doc);
    if (!modal) return null;
    const titleEl = q(modal, SEL.detailTitle);
    const title = titleEl?.getAttribute('alt') || titleEl?.querySelector('img')?.getAttribute('alt') || text(titleEl);
    const episodes: Episode[] = qa(modal, SEL.episode).map((el, index) => ({
        index,
        label: text(q(el, SEL.episodeIndex)) || String(index + 1),
        title: text(q(el, SEL.episodeTitle)),
        synopsis: text(q(el, SEL.episodeSynopsis)),
        img: imageOf(el),
        progress: progressOf(el),
    }));
    const toggle = q(modal, SEL.seasonToggle);
    let seasons: string[] = [];
    let season = 0;
    if (toggle instanceof HTMLSelectElement) {
        seasons = Array.from(toggle.options, (o) => text(o));
        season = toggle.selectedIndex;
    } else if (toggle) {
        seasons = [text(toggle)];
    }
    const id =
        videoIdFromHref(location.search) ??
        videoIdFromHref(q<HTMLAnchorElement>(modal, 'a[href*="/watch/"]')?.getAttribute('href') ?? null);
    return {
        id,
        title,
        synopsis: text(q(modal, SEL.detailSynopsis)),
        img: imageOf(modal),
        seasons,
        season,
        episodes,
    };
}

export function readCatalog(doc: Document, offset = 0, limit = 8): Catalog {
    const page = detectPageKind(location, doc);
    const rows = page === 'profiles' ? [] : readRows(doc).filter((r) => r.items.length);
    return {
        page,
        rows: rows.slice(offset, offset + limit),
        totalRows: rows.length,
        profiles: page === 'profiles' ? readProfiles(doc) : [],
        detail: page === 'title' ? readDetail(doc) : null,
    };
}

// ---- acting ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function go(path: string) {
    location.assign(new URL(path, location.origin).href);
}

async function chooseSeason(doc: Document, index: number): Promise<CommandResult> {
    const modal = detailRoot(doc);
    const toggle = modal && q(modal, SEL.seasonToggle);
    if (!toggle) return { ok: false, error: 'Keine Staffelauswahl gefunden' };
    if (toggle instanceof HTMLSelectElement) {
        toggle.selectedIndex = index;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
    }
    toggle.click();
    await sleep(300);
    const option = qa(doc, SEL.seasonOption)[index];
    if (!option) return { ok: false, error: 'Staffel nicht gefunden' };
    option.click();
    await sleep(500);
    return { ok: true };
}

/** Short CSS path of an element (tag.class#uia) for diagnostics. */
function describe(el: Element | null, depth = 6): string {
    const parts: string[] = [];
    for (let e = el; e && e !== document.body && parts.length < depth; e = e.parentElement) {
        const cls = Array.from(e.classList).slice(0, 3).join('.');
        const uia = e.getAttribute('data-uia');
        const ctx = e.getAttribute('data-list-context');
        parts.unshift(`${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}${uia ? `[uia=${uia}]` : ''}${ctx ? `[ctx=${ctx}]` : ''}`);
    }
    return parts.join(' > ');
}

/** What the page looks like to the scraper; the phone can show it so users can report markup changes. */
export function diagnose(doc: Document): Record<string, unknown> {
    const count = (sel: Sel) =>
        Object.fromEntries((typeof sel === 'string' ? [sel] : sel).map((s) => [s, doc.querySelectorAll(s).length]));
    const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>(SEL.titleLinks));
    const catalog = readCatalog(doc, 0, 50);
    return {
        version: globalThis.chrome?.runtime?.getManifest?.().version ?? '?',
        location: location.pathname + location.search,
        page: catalog.page,
        titleLinks: links.length,
        rows: catalog.rows.map((r) => `${r.title || '(ohne Titel)'}: ${r.items.length}`),
        profiles: catalog.profiles.map((p) => p.name),
        detail: catalog.detail && { title: catalog.detail.title, episodes: catalog.detail.episodes.length, seasons: catalog.detail.seasons },
        selectors: {
            row: count(SEL.row),
            rowTitle: count(SEL.rowTitle),
            card: count(SEL.card),
            profileGate: count(SEL.profileGate),
            detail: count(SEL.detail),
            episode: count(SEL.episode),
        },
        sampleLinks: links.slice(0, 5).map((a) => ({
            href: a.getAttribute('href')?.slice(0, 60),
            label: a.getAttribute('aria-label'),
            img: !!a.closest('div')?.querySelector('img'),
            path: describe(a),
        })),
        sampleHeadings: Array.from(doc.querySelectorAll('h2, h3'))
            .slice(0, 5)
            .map((h) => `${text(h).slice(0, 40)} ← ${describe(h, 4)}`),
    };
}

export async function runCatalogCommand(doc: Document, cmd: CatalogCommand): Promise<CommandResult> {
    switch (cmd.type) {
        case 'catalog.get':
            return { ok: true, data: readCatalog(doc, cmd.offset, cmd.limit) };
        case 'catalog.debug':
            return { ok: true, data: diagnose(doc) };
        case 'catalog.loadMore':
            // Netflix renders further rows only when they scroll into view.
            window.scrollBy({ top: window.innerHeight * 3 });
            await sleep(1200);
            return { ok: true };
        case 'catalog.play': {
            // Clicking an existing link keeps Netflix's single-page app warm; fall back to navigation.
            const link = doc.querySelector<HTMLAnchorElement>(`a[href*="/watch/${cmd.id}"]`);
            if (link) link.click();
            else go(`/watch/${cmd.id}`);
            return { ok: true };
        }
        case 'catalog.open':
            go(`/browse?jbv=${cmd.id}`);
            return { ok: true };
        case 'catalog.episode': {
            const ep = detailRoot(doc) && qa(detailRoot(doc)!, SEL.episode)[cmd.index];
            if (!ep) return { ok: false, error: 'Folge nicht gefunden' };
            (q(ep, 'a[href*="/watch/"]') ?? ep).click();
            return { ok: true };
        }
        case 'catalog.season':
            return chooseSeason(doc, cmd.index);
        case 'catalog.profile': {
            const profile = profileLinks(doc)[cmd.index];
            if (!profile) return { ok: false, error: 'Profil nicht gefunden' };
            profile.click();
            return { ok: true };
        }
        case 'catalog.search':
            go(`/search?q=${encodeURIComponent(cmd.q)}`);
            return { ok: true };
        case 'catalog.nav':
            go(SECTION_URLS[cmd.section]);
            return { ok: true };
        case 'catalog.back': {
            const modal = detailRoot(doc);
            if (modal) {
                const close = q(modal, SEL.detailClose);
                if (close) close.click();
                else doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                return { ok: true };
            }
            history.back();
            return { ok: true };
        }
    }
}
