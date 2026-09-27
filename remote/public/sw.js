// Offline shell for the installed app. The page itself is loaded network-first so a new
// version shows up on the next start; hashed assets are served from cache, refreshed in the background.
const CACHE = 'couch-remote-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    if (res.ok) void caches.open(CACHE).then((cache) => cache.put(req, copy));
                    return res;
                })
                .catch(() => caches.match(req, { ignoreSearch: true })),
        );
        return;
    }
    event.respondWith(
        caches.open(CACHE).then(async (cache) => {
            const cached = await cache.match(req, { ignoreSearch: true });
            const network = fetch(req)
                .then((res) => {
                    if (res.ok) void cache.put(req, res.clone());
                    return res;
                })
                .catch(() => cached);
            return cached ?? network;
        }),
    );
});
