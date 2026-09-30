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
    Billboard,
    Episode,
    Profile,
    TitleDetail,
} from '../../../shared/protocol';
import { SECTION_URLS } from '../../../shared/protocol';
import { detectPageKind } from './page-kind';
import { detailsUrl, rememberReturn } from './return-to';
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
    // The selector may hit the <img> itself (e.g. a plain avatar image on the profile gate).
    const img = root instanceof HTMLImageElement ? root : root.querySelector('img');
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

/**
 * The title details dialog. Other dialogs (cookie settings!) must never count: with the generic
 * `[role="dialog"]` fallback they would show up on the phone as a title while the real details load.
 */
function detailRoot(doc: Document): HTMLElement | null {
    for (const s of SEL.detail) {
        const generic = s === '[role="dialog"]';
        for (const el of doc.querySelectorAll<HTMLElement>(s)) {
            if (el.closest(SEL.consent)) continue;
            if (generic && !el.querySelector(SEL.detailMarker)) continue;
            return el;
        }
    }
    return null;
}

// ---- reading ---------------------------------------------------------------------

function readRows(doc: Document, root: ParentNode = doc): CatalogRow[] {
    const modal = detailRoot(doc);
    const rows = new Map<Element | null, CatalogRow & { seen: Set<string> }>();

    for (const a of root.querySelectorAll<HTMLAnchorElement>(SEL.titleLinks)) {
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

function readBillboard(doc: Document): Billboard | null {
    const root = q(doc, SEL.billboard);
    if (!root) return null;
    const links = Array.from(root.querySelectorAll(SEL.billboardLinks));
    const id =
        links.map((el) => videoIdFromHref(el.getAttribute('href')) ?? el.getAttribute('data-videoid')).find((x) => x && /^\d+$/.test(x)) ??
        null;
    if (!id) return null;
    const logo = q<HTMLImageElement>(root, SEL.billboardLogo);
    // The background is the large image that is not the title logo.
    const hero = q(root, SEL.billboardImage) ?? Array.from(root.querySelectorAll('img')).find((img) => img !== logo) ?? null;
    const label = links.map((el) => el.getAttribute('aria-label')?.trim() ?? '').find((l) => l && !GENERIC_LINK_TEXT.test(l));
    const title = logo?.getAttribute('alt')?.trim() || label || text(q(root, '.billboard-title'));
    const img = imageOf(hero);
    if (!title && !img) return null;
    return { id, title, synopsis: text(q(root, SEL.billboardSynopsis)), img, logo: imageOf(logo) };
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

/** Episodes of the shown season, without the suggestions and trailers further down the details. */
function titleCards(modal: HTMLElement): HTMLElement[] {
    const all = new Set<HTMLElement>();
    for (const s of SEL.episode) modal.querySelectorAll<HTMLElement>(s).forEach((el) => all.add(el));
    // Outermost cards only: some selectors match a card and its inner wrapper.
    return [...all].filter((el) => ![...all].some((other) => other !== el && other.contains(el)));
}

const hasEpisodeNumber = (card: HTMLElement) => /^\d{1,4}$/.test(text(q(card, SEL.episodeIndex)));
/** Inside a suggestions or trailers block of these details (not somewhere above them). */
const inSuggestions = (card: HTMLElement, modal: HTMLElement) => {
    const block = card.closest(SEL.notEpisode);
    return !!block && modal.contains(block);
};

/**
 * Episodes of the shown season, without the suggestions and trailers further down the details:
 * those use the same title cards, but only episodes carry an episode number.
 */
function episodeCards(modal: HTMLElement): HTMLElement[] {
    const cards = titleCards(modal);
    const numbered = cards.filter(hasEpisodeNumber);
    if (numbered.length) return numbered;
    return cards.filter((el) => !inSuggestions(el, modal));
}

function yearOf(modal: HTMLElement): number | null {
    const y = Number(text(q(modal, SEL.detailYear)).match(/\b(19|20)\d{2}\b/)?.[0]);
    return y || null;
}

/**
 * Seasons of a series. Netflix's season picker is a button whose menu entries only exist while it is
 * open, so without them the count comes from the metadata line ("3 Staffeln") and the labels follow
 * the button's ("Staffel 1" → "Staffel 1" … "Staffel 3").
 */
function readSeasons(doc: Document, modal: HTMLElement): { seasons: string[]; season: number } {
    const toggle = q(modal, SEL.seasonToggle);
    if (!toggle) return { seasons: [], season: 0 };
    if (toggle instanceof HTMLSelectElement) return { seasons: Array.from(toggle.options, (o) => text(o)), season: toggle.selectedIndex };
    const current = text(toggle);
    const open = qa(doc, SEL.seasonOption).map((el) => text(el)).filter(Boolean);
    if (open.length > 1) return { seasons: open, season: Math.max(0, open.findIndex((o) => current && o.startsWith(current))) };
    const count = Number(text(q(modal, SEL.detailMeta) ?? modal).match(SEASON_COUNT)?.[1]);
    const label = current.match(/^(.*?)(\d+)\s*$/);
    if (count > 1 && count <= 100 && label) {
        return {
            seasons: Array.from({ length: count }, (_, i) => `${label[1]}${i + 1}`),
            season: Math.min(count - 1, Math.max(0, Number(label[2]) - 1)),
        };
    }
    return { seasons: current ? [current] : [], season: 0 };
}

const SEASON_COUNT = /(\d+)\s*(Staffeln|Seasons|Teile|Parts|Temporadas|Saisons|Stagioni)/i;

function readDetail(doc: Document): TitleDetail | null {
    const modal = detailRoot(doc);
    if (!modal) return null;
    const titleEl = q(modal, SEL.detailTitle);
    const title = titleEl?.getAttribute('alt') || titleEl?.querySelector('img')?.getAttribute('alt') || text(titleEl);
    const episodes: Episode[] = episodeCards(modal).map((el, index) => ({
        index,
        label: text(q(el, SEL.episodeIndex)) || String(index + 1),
        title: text(q(el, SEL.episodeTitle)),
        synopsis: text(q(el, SEL.episodeSynopsis)),
        img: imageOf(el),
        progress: progressOf(el),
    }));
    const { seasons, season } = readSeasons(doc, modal);
    const id =
        videoIdFromHref(location.search) ??
        videoIdFromHref(q<HTMLAnchorElement>(modal, 'a[href*="/watch/"]')?.getAttribute('href') ?? null);
    return {
        id,
        title,
        year: yearOf(modal),
        synopsis: text(q(modal, SEL.detailSynopsis)),
        img: imageOf(modal),
        seasons,
        season,
        episodes,
    };
}

/** Trailer previews: every <video> outside the player (only the player page has one of its own). */
function previewVideos(doc: Document): HTMLVideoElement[] {
    if (location.pathname.startsWith('/watch/')) return [];
    return Array.from(doc.querySelectorAll('video'));
}

function previewMuted(doc: Document): boolean | null {
    const videos = previewVideos(doc);
    if (videos.length) return videos.every((v) => v.muted || v.volume === 0);
    const toggle = q(doc, SEL.previewAudioToggle);
    if (!toggle) return null;
    return /(^|-)muted$/.test(toggle.getAttribute('data-uia') ?? '');
}

async function setPreviewSound(doc: Document, muted: boolean): Promise<CommandResult> {
    if (previewMuted(doc) === muted) return { ok: true };
    // Prefer Netflix's own button: Netflix then keeps the choice for later previews.
    const toggle = q(doc, SEL.previewAudioToggle);
    if (toggle) {
        toggle.click();
        await sleep(300);
    }
    if (previewMuted(doc) !== muted) for (const v of previewVideos(doc)) v.muted = muted;
    return previewMuted(doc) === null ? { ok: false, error: 'Gerade läuft keine Vorschau' } : { ok: true };
}

export function readCatalog(doc: Document, offset = 0, limit = 8): Catalog {
    const page = detectPageKind(location, doc);
    // Search: only the result grid counts, once Netflix has rendered it (before that it shows other rows).
    const results = page === 'search' ? q(doc, SEL.searchResults) : null;
    const rows = page === 'profiles' ? [] : readRows(doc, results ?? doc).filter((r) => r.items.length);
    return {
        page,
        rows: rows.slice(offset, offset + limit),
        totalRows: rows.length,
        profiles: page === 'profiles' ? readProfiles(doc) : [],
        detail: page === 'title' ? readDetail(doc) : null,
        billboard: page === 'browse' ? readBillboard(doc) : null,
        previewMuted: page === 'browse' || page === 'title' ? previewMuted(doc) : null,
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
        rows: catalog.rows.map(
            (r) =>
                `${r.title || '(ohne Titel)'}: ${r.items.length} – ${r.items
                    .slice(0, 4)
                    .map((i) => i.name)
                    .join(', ')}`,
        ),
        searchResults: catalog.page === 'search' ? (q(doc, SEL.searchResults) ? describe(q(doc, SEL.searchResults), 3) : 'nicht gefunden') : undefined,
        profiles: catalog.profiles.map((p) => p.name),
        detail: catalog.detail && { title: catalog.detail.title, year: catalog.detail.year, episodes: catalog.detail.episodes.length, seasons: catalog.detail.seasons },
        /** How the season picker looks, to follow Netflix when it changes. */
        seasonPicker: (() => {
            const modal = detailRoot(doc);
            const toggle = modal && q(modal, SEL.seasonToggle);
            if (!modal || !toggle) return undefined;
            return {
                toggle: `${text(toggle).slice(0, 30)} – ${describe(toggle, 3)}`,
                meta: text(q(modal, SEL.detailMeta)).slice(0, 80) || 'nicht gefunden',
                openOptions: qa(doc, SEL.seasonOption).length,
            };
        })(),
        /** Title cards in the details: which count as episodes, and where they sit. */
        detailCards: (() => {
            const modal = detailRoot(doc);
            if (!modal) return undefined;
            const cards = titleCards(modal);
            return {
                cards: cards.length,
                numbered: cards.filter(hasEpisodeNumber).length,
                inSuggestions: cards.filter((el) => inSuggestions(el, modal)).length,
                samples: [cards[0], cards[cards.length - 1]].filter(Boolean).map((el) => ({
                    number: text(q(el, SEL.episodeIndex)).slice(0, 10),
                    title: text(q(el, SEL.episodeTitle)).slice(0, 40),
                    path: describe(el, 5),
                })),
            };
        })(),
        billboard: catalog.billboard && { ...catalog.billboard, img: !!catalog.billboard.img, logo: !!catalog.billboard.logo },
        selectors: {
            row: count(SEL.row),
            rowTitle: count(SEL.rowTitle),
            card: count(SEL.card),
            profileGate: count(SEL.profileGate),
            detail: count(SEL.detail),
            billboard: count(SEL.billboard),
            billboardLogo: count(SEL.billboardLogo),
            billboardImage: count(SEL.billboardImage),
            previewAudioToggle: count(SEL.previewAudioToggle),
            video: count('video'),
            episode: count(SEL.episode),
            searchResults: count(SEL.searchResults),
        },
        sampleLinks: links.slice(0, 5).map((a) => ({
            href: a.getAttribute('href')?.slice(0, 60),
            label: a.getAttribute('aria-label'),
            img: !!a.closest('div')?.querySelector('img'),
            path: describe(a),
        })),
        previewMuted: catalog.previewMuted,
        /** Buttons around previews, to find Netflix's mute button when its markup changes. */
        previewButtons: [q(doc, SEL.billboard), detailRoot(doc)]
            .flatMap((root) => (root ? Array.from(root.querySelectorAll('button')) : []))
            .slice(0, 12)
            .map((b) => `${b.getAttribute('data-uia') ?? '-'} | ${b.getAttribute('aria-label') ?? text(b).slice(0, 30)}`),
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
            rememberReturn(new URL(location.href), sessionStorage);
            // Clicking an existing link keeps Netflix's single-page app warm; fall back to navigation.
            const link = doc.querySelector<HTMLAnchorElement>(`a[href*="/watch/${cmd.id}"]`);
            if (link) link.click();
            else go(`/watch/${cmd.id}`);
            return { ok: true };
        }
        case 'catalog.open':
            go(detailsUrl(new URL(location.href), cmd.id));
            return { ok: true };
        case 'catalog.episode': {
            const root = detailRoot(doc);
            const ep = root && episodeCards(root)[cmd.index];
            if (!ep) return { ok: false, error: 'Folge nicht gefunden' };
            rememberReturn(new URL(location.href), sessionStorage);
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
        case 'catalog.previewSound':
            return setPreviewSound(doc, cmd.muted);
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
