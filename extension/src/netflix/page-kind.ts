import type { PageKind } from '../../../shared/protocol';
import { SEL } from './selectors';

export function detectPageKind(loc: Location | URL, doc: Document): PageKind {
    const path = loc.pathname;
    if (path.startsWith('/watch/')) return 'watch';
    if (/\/(login|signup)(\/|$)/.test(path)) return 'login';
    if (SEL.profileGate.some((s) => doc.querySelector(s))) return 'profiles';
    if (path.startsWith('/title/') || new URLSearchParams(loc.search).has('jbv')) return 'title';
    if (path.startsWith('/search')) return 'search';
    if (path.startsWith('/browse') || path.startsWith('/latest')) return 'browse';
    return 'other';
}
