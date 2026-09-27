import type { PageKind } from '../../../shared/protocol';
import { SEL } from './selectors';

/** Profile links outside the header menus (the header also offers a profile switcher). */
export function profileGateElements(doc: Document): HTMLElement[] {
    for (const s of SEL.profileGate) {
        const found = Array.from(doc.querySelectorAll<HTMLElement>(s)).filter((el) => !el.closest(SEL.headerMenus));
        if (found.length) return found;
    }
    return [];
}

export function detectPageKind(loc: Location | URL, doc: Document): PageKind {
    const path = loc.pathname;
    if (path.startsWith('/watch/')) return 'watch';
    if (/\/(login|signup)(\/|$)/.test(path)) return 'login';
    // The profile gate shows no titles; a page full of title links is a browse page whatever else it has.
    if (profileGateElements(doc).length && doc.querySelectorAll(SEL.titleLinks).length < 3) return 'profiles';
    if (path.startsWith('/title/') || new URLSearchParams(loc.search).has('jbv')) return 'title';
    if (path.startsWith('/search')) return 'search';
    if (path.startsWith('/browse') || path.startsWith('/latest')) return 'browse';
    return 'other';
}
