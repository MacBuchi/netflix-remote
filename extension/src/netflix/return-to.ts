// Where "back" should lead. Netflix's own navigation forgets the search: its player back button and
// details opened elsewhere return to the home page. The tab's sessionStorage (shared by content
// script and page world, gone with the tab) remembers the search to return to it.

const KEY = 'nfr.returnTo';

/** Details over the current list (search, genre …) so closing them returns there; elsewhere over /browse. */
export function detailsUrl(current: URL, id: string): string {
    const listPage = /^\/(browse|search|latest)(\/|$)/.test(current.pathname);
    const url = new URL(listPage ? current.href : new URL('/browse', current).href);
    url.searchParams.set('jbv', id);
    return url.pathname + url.search;
}

/** Called before playing: remember a search page (without an open details dialog) to come back to. */
export function rememberReturn(current: URL, storage: Storage) {
    try {
        if (!current.pathname.startsWith('/search')) return storage.removeItem(KEY);
        const url = new URL(current.href);
        url.searchParams.delete('jbv');
        storage.setItem(KEY, url.pathname + url.search);
    } catch {
        /* storage blocked: Netflix's own back behaviour */
    }
}

/** The remembered page, once: leaving the player uses it up. */
export function takeReturn(storage: Storage): string | null {
    try {
        const target = storage.getItem(KEY);
        storage.removeItem(KEY);
        return target && target.startsWith('/search') ? target : null;
    } catch {
        return null;
    }
}
