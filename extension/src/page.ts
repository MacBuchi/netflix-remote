// Runs in Netflix's own JavaScript world (manifest "world": "MAIN") so it can
// reach the internal player API. Talks to content.ts via window.postMessage.

import type { PageRequest, PageResponse } from './messages';
import { PlayerAdapter } from './netflix/player';

const w = window as Window & { __nfrPage?: boolean };
if (!w.__nfrPage) {
    w.__nfrPage = true;
    const adapter = new PlayerAdapter(window);
    window.addEventListener('message', (e: MessageEvent<PageRequest>) => {
        if (e.source !== window || e.data?.__nfr !== 'req') return;
        const req = e.data;
        const result = req.kind === 'state' ? adapter.getState() : adapter.run(req.cmd);
        const res: PageResponse = { __nfr: 'res', id: req.id, result };
        window.postMessage(res, window.location.origin);
    });
}
