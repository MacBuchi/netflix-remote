// End-to-end test of the whole chain without Netflix or the internet:
//   phone app (built PWA) --WebRTC--> extension (offscreen → service worker → content → page) --> fake Netflix page
// A local PeerJS server stands in for the public broker; netflix.com is routed to tests/e2e/fake-netflix.html.
//
// Prerequisite: npm run build.  Run: npm run test:e2e
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { Aedes } from 'aedes';
import { PeerServer } from 'peer';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const EXT = join(ROOT, 'extension/dist');
const REMOTE = join(ROOT, 'remote/dist');
const PEER_PORT = 9123;
const WEB_PORT = 9124;
const MQTT_PORT = 9125;
const SHOTS = process.env.E2E_SCREENSHOTS;

const fakeNetflix = await readFile(join(import.meta.dirname, 'fake-netflix.html'), 'utf8');
// The update test rewrites the manifest in the folder; restored at the end.
const originalManifest = await readFile(join(EXT, 'manifest.json'), 'utf8');
const installed = JSON.parse(originalManifest).version;

/** Placeholder image for the fake page's CDN URLs: a colored poster titled after `t`, a text-free
 *  billboard background (`hero`) or a title logo (`logo`). */
function posterSvg(url) {
    const params = new URL(url).searchParams;
    const title = params.get('t') ?? '';
    const esc = title.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    if (params.has('logo')) {
        const width = title.length * 48;
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="90" viewBox="0 0 ${width} 90">
            <text x="0" y="68" textLength="${width - 8}" fill="#fff" font-family="Georgia, serif" font-size="64" font-weight="700">${esc.toUpperCase()}</text></svg>`;
    }
    const hue = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 200);
    const label = params.has('hero')
        ? `<circle cx="230" cy="70" r="90" fill="hsl(${(hue + 30) % 360},80%,60%)" opacity="0.35"/>`
        : `<text x="160" y="100" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" text-anchor="middle">${esc}</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
        <defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,14%)"/></linearGradient></defs>
        <rect width="320" height="180" fill="url(#g)"/>${label}</svg>`;
}
// Stand-in for OMDb: accepts only the key "test-key" and knows some of the fake titles.
const OMDB_TITLES = {
    Sternenstaub: { Title: 'Stardust', Year: '2019', imdbID: 'tt9000001', imdbRating: '8.1', Metascore: '81', Ratings: [{ Source: 'Rotten Tomatoes', Value: '94%' }] },
    Hafenlichter: { Title: 'Harbour Lights', Year: '2021', imdbID: 'tt9000002', imdbRating: '7.9', Ratings: [{ Source: 'Rotten Tomatoes', Value: '88%' }] },
    Nachtfalter: { Title: 'Moth', Year: '2019–', imdbID: 'tt9000003', imdbRating: '8.7', Ratings: [] },
};
const omdb = (route) => {
    const p = new URL(route.request().url()).searchParams;
    const byId = Object.values(OMDB_TITLES).find((t) => t.imdbID === p.get('i'));
    const found = p.get('i') ? (byId ?? { Title: 'Testfilm', imdbID: p.get('i'), imdbRating: '9.3' }) : OMDB_TITLES[p.get('t')];
    const body =
        p.get('apikey') !== 'test-key'
            ? { Response: 'False', Error: 'Invalid API key!' }
            : found
              ? { Response: 'True', ...found }
              : { Response: 'False', Error: 'Movie not found!' };
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
};

// Stand-in for Wikidata: the billboard title by Netflix id (P1874 → IMDb id), others by their German name.
const WIKIDATA_IDS = { 80025678: 'tt9000002' };
const WIKIDATA_NAMES = {
    Sternenstaub: [{ id: 'tt9000001', year: 2019, series: false }],
    // Two works share the name: the details' year (a series started 2019, latest season 2021) decides.
    Nachtfalter: [{ id: 'tt9000009', year: 1996, series: false }, { id: 'tt9000003', year: 2019, series: true }],
};
const wikidata = (route) => {
    const query = new URL(route.request().url()).searchParams.get('query') ?? '';
    const nf = query.match(/P1874 "(\d+)"/)?.[1];
    const name = query.match(/mwapi:search "([^"]*)"/)?.[1];
    const bindings = nf
        ? WIKIDATA_IDS[nf] ? [{ imdb: { value: WIKIDATA_IDS[nf] } }] : []
        : (WIKIDATA_NAMES[name] ?? []).map((c) => ({ id: { value: c.id }, year: { value: String(c.year) }, series: { value: String(c.series) } }));
    return route.fulfill({
        contentType: 'application/sparql-results+json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ results: { bindings } }),
    });
};

// Stand-in for GitHub's "latest release" answer; the update step publishes a newer one.
let githubRelease = null;
const github = (route) =>
    githubRelease
        ? route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(githubRelease) })
        : route.fulfill({ status: 404, body: '{}' });

// Never fetch the Netflix CDN (CI has internet, real requests would stall page loads); for screenshots draw placeholders.
const cdn = (route) =>
    SHOTS ? route.fulfill({ contentType: 'image/svg+xml', body: posterSvg(route.request().url()) }) : route.abort();

const peerServer = PeerServer({ port: PEER_PORT, host: '127.0.0.1', path: '/' });
const web = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = join(REMOTE, path === '/' ? 'index.html' : path);
    try {
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        res.end(await readFile(file));
    } catch {
        res.writeHead(404).end();
    }
}).listen(WEB_PORT, '127.0.0.1');

// Local stand-in for the public MQTT relay.
const aedes = await Aedes.createBroker();
const mqttServer = new WebSocketServer({ host: '127.0.0.1', port: MQTT_PORT, path: '/mqtt' });
mqttServer.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
// Public brokers cap message sizes; track the largest message to prove the relay stays small.
let largestRelayMessage = 0;
aedes.on('publish', (packet) => {
    if (packet.topic.startsWith('nfr/')) largestRelayMessage = Math.max(largestRelayMessage, packet.payload.length);
});

// Lets context.route() see the extension service worker's requests (the GitHub update check).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const webrtcArgs = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
// E2E_BROWSER=<path> runs the PC side in another Chromium browser (e.g. Opera) to check compatibility.
const BROWSER = process.env.E2E_BROWSER;
// Chromium gets the extension like "Load unpacked" does, so it can reload itself after an update
// (extensions from the command line cannot); other browsers get it from the command line.
const pc = await chromium.launchPersistentContext('', {
    ...(BROWSER ? { executablePath: BROWSER } : { channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'] }),
    headless: !BROWSER,
    args: BROWSER
        ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...webrtcArgs]
        : ['--enable-unsafe-extension-debugging', ...webrtcArgs],
});
const loadedId = BROWSER ? null : (await (await pc.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT })).id;
const phoneBrowser = await chromium.launch({ args: webrtcArgs });
// A phone in a network that blocks direct connections: WebRTC may only use (non-existent) proxies.
const hotelPhoneBrowser = await chromium.launch({ args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });

async function newHotelPhone() {
    const ctx = await hotelPhoneBrowser.newContext({ viewport: { width: 400, height: 860 } });
    await ctx.route('https://*.nflxso.net/**', cdn);
    return ctx.newPage();
}

let failed = false;
/** Pages whose visible text is printed when a step fails, to see what the user would have seen. */
const watched = {};
const step = async (name, fn) => {
    process.stdout.write(`• ${name} … `);
    try {
        await fn();
        console.log('ok');
    } catch (e) {
        console.log('FAILED');
        for (const [label, page] of Object.entries(watched)) {
            const shown = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '(closed)');
            console.log(`--- ${label} shows:\n${shown.slice(0, 1500)}`);
        }
        throw e;
    }
};

try {
    await pc.route('https://www.netflix.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fakeNetflix }));
    await pc.route('https://*.nflxso.net/**', cdn);
    await pc.route('https://api.github.com/**', github);

    const extId = loadedId ?? new URL((pc.serviceWorkers()[0] ?? (await pc.waitForEvent('serviceworker'))).url()).host;
    const isExt = (w) => new URL(w.url()).host === extId;
    const extensionWorker = async () => pc.serviceWorkers().find(isExt) ?? pc.waitForEvent('serviceworker', { predicate: isExt });

    let config;
    await step('configure extension via popup (local broker, local phone app)', async () => {
        const popup = await pc.newPage();
        await popup.goto(`chrome-extension://${extId}/popup.html`);
        await popup.locator('details summary').click();
        await popup.fill('#remote-url', `http://localhost:${WEB_PORT}/`);
        await popup.fill('#broker', `ws://localhost:${PEER_PORT}/`);
        await popup.fill('#relay', `ws://127.0.0.1:${MQTT_PORT}/mqtt`);
        await popup.click('#save');
        await popup.fill('#name', 'Test-Mac');
        await popup.locator('#name').dispatchEvent('change');
        await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'getConfig' })).pcName === 'Test-Mac');
        await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Bereit'), null, { timeout: 15_000 });
        config = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'getConfig' }));
        assert.equal(config.pcName, 'Test-Mac');
        if (SHOTS) {
            await popup.locator('details').evaluate((d) => (d.open = false));
            await popup.setViewportSize({ width: 360, height: 560 });
            await popup.screenshot({ path: join(SHOTS, 'popup.png'), fullPage: true });
        }
        await popup.close();
    });

    const netflix = await pc.newPage();
    await netflix.goto('https://www.netflix.com/watch/80100172');

    const pairingUrl = `http://localhost:${WEB_PORT}/#${new URLSearchParams({ pc: config.peerId, k: config.key, n: config.pcName, b: config.broker, r: config.relay, d: 'Chrome · macOS' })}`;
    const phoneCtx = await phoneBrowser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true });
    await phoneCtx.route('https://*.nflxso.net/**', cdn);
    await phoneCtx.route('https://www.omdbapi.com/**', omdb);
    await phoneCtx.route('https://query.wikidata.org/**', wikidata);
    const phone = await phoneCtx.newPage();
    watched.phone = phone;

    await step('phone pairs via QR link and ends up on the direct WebRTC link', async () => {
        // Earlier pairings of this PC (reinstalled extension: new id, same name) are replaced.
        await phone.goto(`http://localhost:${WEB_PORT}/`);
        await phone.evaluate(() => {
            const old = (peerId, name) => ({ peerId, key: 'ffffffffffffffffffffffffffffffff', name, broker: '', relay: '' });
            localStorage.setItem('nfr.pairings', JSON.stringify([old('nfr-oldtestmac1', 'Test-Mac'), old('nfr-oldtestmac2', 'Test-Mac')]));
        });
        await phone.goto(pairingUrl);
        await phone.locator('.dot.connected').waitFor({ timeout: 20_000 });
        await phone.locator('.via', { hasText: 'Direkt' }).waitFor({ timeout: 20_000 });
        assert.equal(await phone.locator('.pc-name').textContent(), 'Test-Mac');
        assert.equal(new URL(phone.url()).hash, '', 'secret removed from address bar');
    });

    await step('settings list the paired PCs with browser, system and date, without duplicates', async () => {
        await phone.getByRole('button', { name: 'Einstellungen' }).click();
        const list = phone.getByRole('dialog', { name: 'Einstellungen' }).locator('.pc-list li');
        await list.first().waitFor();
        assert.deepEqual(await list.locator('strong').allTextContents(), ['Test-Mac']);
        const today = new Date().toLocaleDateString('de-DE');
        await list.first().getByText(`Chrome · macOS · gekoppelt am ${today}`).waitFor();
        await phone.getByRole('dialog', { name: 'Einstellungen' }).getByRole('button', { name: 'Schließen' }).click();
    });

    await step('player state reaches the phone', async () => {
        await phone.getByRole('heading', { name: 'Nachtfalter' }).waitFor({ timeout: 10_000 });
        await phone.getByText('S1:E3 · Geheimnisse').waitFor();
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-player.png') });
    });

    await step('pause / play', async () => {
        await phone.getByRole('button', { name: 'Pause' }).click();
        await netflix.waitForFunction(() => window.fake.paused === true);
        await phone.getByRole('button', { name: 'Abspielen' }).waitFor();
        await phone.getByRole('button', { name: 'Abspielen' }).click();
        await netflix.waitForFunction(() => window.fake.paused === false);
    });

    await step('seek +10s through player.seek()', async () => {
        const before = await netflix.evaluate(() => window.fake.t);
        await phone.getByRole('button', { name: '10 Sekunden vor' }).click();
        await netflix.waitForFunction((b) => window.fake.t >= b + 10_000, before);
    });

    await step('volume', async () => {
        await phone.getByRole('button', { name: 'Lauter' }).click();
        await netflix.waitForFunction(() => Math.abs(window.fake.vol - 0.6) < 0.001);
        await phone.locator('.vol-num', { hasText: '60' }).waitFor();
    });

    await step('playback speed', async () => {
        await phone.getByRole('button', { name: 'Geschwindigkeit 1,5×' }).click();
        await netflix.waitForFunction(() => window.fake.rate === 1.5 && document.querySelector('video').playbackRate === 1.5);
        await phone.locator('.speed-btn[aria-pressed="true"]', { hasText: '1,5×' }).waitFor({ timeout: 10_000 });
        await phone.getByRole('button', { name: 'Geschwindigkeit 1×' }).click();
        await netflix.waitForFunction(() => document.querySelector('video').playbackRate === 1);
    });

    await step('subtitle track', async () => {
        await phone.getByLabel('Untertitel').selectOption('t-de');
        await netflix.waitForFunction(() => window.fake.text.trackId === 't-de');
    });

    await step('skip intro button appears and works', async () => {
        await netflix.evaluate(() => window.fake.showSkip());
        await phone.getByRole('button', { name: 'Intro überspringen' }).click();
        await netflix.waitForFunction(() => window.fake.skipped === 1);
        await phone.getByRole('button', { name: 'Intro überspringen' }).waitFor({ state: 'detached' });
    });

    await step('connection survives a Netflix tab reload', async () => {
        await netflix.reload();
        await netflix.evaluate(() => (window.fake.t = 5000));
        await phone.getByText('0:05').waitFor({ timeout: 10_000 });
        assert.equal(await phone.locator('.dot.connected').count(), 1);
    });

    await step('phone in a Wi-Fi that blocks direct connections works through the encrypted relay', async () => {
        const hotel = await newHotelPhone();
        await hotel.goto(pairingUrl);
        await hotel.locator('.via', { hasText: 'Relay' }).waitFor({ timeout: 20_000 });
        await hotel.getByRole('heading', { name: 'Nachtfalter' }).waitFor({ timeout: 15_000 });
        await hotel.getByRole('button', { name: 'Pause' }).click();
        await netflix.waitForFunction(() => window.fake.paused === true);
        await hotel.getByRole('button', { name: 'Abspielen' }).waitFor({ timeout: 10_000 });
        await hotel.getByRole('button', { name: 'Abspielen' }).click();
        await netflix.waitForFunction(() => window.fake.paused === false);
        if (SHOTS) await hotel.screenshot({ path: join(SHOTS, 'remote-relay.png') });
        // Direct attempts keep failing in this network, yet the app stays connected.
        await hotel.waitForTimeout(3000);
        assert.equal(await hotel.locator('.dot.connected').count(), 1);
        assert.equal(await hotel.locator('.via').textContent(), 'Relay', 'direct link must stay blocked in this test');
        await hotel.close();
    });

    await step('catalog: profile gate is shown on the phone and picking a profile works', async () => {
        await netflix.goto('https://www.netflix.com/browse');
        await phone.getByRole('heading', { name: 'Wer schaut gerade?' }).waitFor({ timeout: 15_000 });
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-profiles.png') });
        await phone.getByRole('button', { name: 'Kinder' }).click();
        await netflix.waitForFunction(() => sessionStorage.getItem('profile') === 'Kinder');
    });

    await step('catalog: rows with titles appear on the phone', async () => {
        await phone.getByRole('heading', { name: 'Weiterschauen' }).waitFor({ timeout: 15_000 });
        await phone.getByRole('button', { name: 'Sternenstaub' }).waitFor();
        await phone.getByRole('heading', { name: 'Derzeit beliebt' }).waitFor();
        const progress = phone.getByRole('button', { name: 'Sternenstaub' }).locator('.progress div');
        assert.equal(await progress.getAttribute('style'), 'width: 70%;');
        await phone.getByRole('region', { name: 'Empfehlung: Hafenlichter' }).waitFor({ timeout: 10_000 });
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-catalog.png') });
    });

    await step('catalog also loads through the relay, in parts small enough for public brokers', async () => {
        const hotel = await newHotelPhone();
        await hotel.goto(pairingUrl);
        await hotel.locator('.via', { hasText: 'Relay' }).waitFor({ timeout: 20_000 });
        await hotel.getByRole('heading', { name: 'Reihe 3' }).waitFor({ timeout: 20_000 });
        await hotel.getByRole('button', { name: 'Titel 3-29' }).waitFor();
        assert.ok(largestRelayMessage > 0 && largestRelayMessage < 32_000, `largest relay message ${largestRelayMessage} bytes`);
        await hotel.close();
    });

    await step('ratings: OMDb key in the settings, IMDb / Rotten Tomatoes / Metacritic on titles', async () => {
        await phone.getByRole('button', { name: 'Einstellungen' }).click();
        const settings = phone.getByRole('dialog', { name: 'Einstellungen' });
        await settings.getByLabel('OMDb-Schlüssel').fill('wrong');
        await settings.getByRole('button', { name: 'Speichern' }).click();
        await settings.getByText('nicht angenommen').waitFor();
        // Pasting the example link from OMDb's e-mail takes the key out of it and tests it right away.
        await settings.getByLabel('OMDb-Schlüssel').fill('http://www.omdbapi.com/?i=tt3896198&apikey=test-key');
        // The function test answers with a real lookup; the sheet stays open to show it.
        await settings.getByRole('status').filter({ hasText: 'Funktioniert: „Testfilm“ – IMDb 9,3' }).waitFor();
        await settings.getByRole('link', { name: 'omdbapi.com/apikey.aspx' }).waitFor();
        await settings.getByRole('button', { name: 'Erneut testen' }).waitFor();
        assert.equal(await settings.getByLabel('OMDb-Schlüssel').inputValue(), 'test-key');
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-settings.png') });
        await settings.getByRole('button', { name: 'Schließen' }).click();
        await settings.waitFor({ state: 'detached' });

        await phone.getByRole('button', { name: 'Sternenstaub' }).click();
        const sheet = phone.getByRole('dialog', { name: 'Sternenstaub' });
        await sheet.getByRole('link', { name: 'IMDb 8,1 von 10' }).waitFor({ timeout: 10_000 });
        assert.equal(await sheet.getByRole('link', { name: 'IMDb 8,1 von 10' }).getAttribute('href'), 'https://www.imdb.com/title/tt9000001/');
        await sheet.getByLabel('Rotten Tomatoes 94%').waitFor();
        await sheet.getByLabel('Metacritic 81 von 100').waitFor();
        // Found by its German name in Wikidata; the sheet names the work the numbers belong to.
        await sheet.getByText('Stardust (2019)').waitFor();
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-ratings.png') });
        await sheet.getByRole('button', { name: 'Schließen' }).click();
        // The billboard is found via Wikidata (Netflix id → IMDb id) and shows what is known (no Metacritic).
        const hero = phone.getByRole('region', { name: 'Empfehlung: Hafenlichter' });
        await hero.getByLabel('Rotten Tomatoes 88%').waitFor({ timeout: 10_000 });
        assert.equal(await hero.getByText('MC').count(), 0);
        // Unknown titles say so instead of showing nothing.
        await phone.getByRole('button', { name: 'Rotes Licht' }).click();
        await phone.getByRole('dialog', { name: 'Rotes Licht' }).getByText('Keine Bewertungen gefunden').waitFor({ timeout: 10_000 });
        await phone.getByRole('dialog', { name: 'Rotes Licht' }).getByRole('button', { name: 'Schließen' }).click();
    });

    await step('catalog: the trailer preview sound can be switched from the phone', async () => {
        const hero = phone.getByRole('region', { name: 'Empfehlung: Hafenlichter' });
        await hero.getByRole('button', { name: 'Vorschau-Ton ausschalten' }).click();
        await netflix.waitForFunction(() => document.querySelector('.billboard video').muted === true);
        await hero.getByRole('button', { name: 'Vorschau-Ton einschalten' }).waitFor({ timeout: 10_000 });
        await hero.getByRole('button', { name: 'Vorschau-Ton einschalten' }).click();
        await netflix.waitForFunction(() => document.querySelector('.billboard video').muted === false);
        await hero.getByRole('button', { name: 'Vorschau-Ton ausschalten' }).waitFor({ timeout: 10_000 });
    });

    await step('catalog: the billboard is shown on top and "Abspielen" starts it on the PC', async () => {
        const hero = phone.getByRole('region', { name: 'Empfehlung: Hafenlichter' });
        await hero.waitFor({ timeout: 15_000 });
        await hero.getByText('Eine Hafenstadt, drei Familien', { exact: false }).waitFor();
        await hero.getByRole('button', { name: 'Abspielen' }).click();
        await netflix.waitForURL(/\/watch\/80025678/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 10_000 });
        await phone.getByRole('button', { name: 'Zurück zur Übersicht' }).click();
        await phone.getByRole('button', { name: 'Sternenstaub' }).waitFor({ timeout: 15_000 });
    });

    await step('catalog: tapping a title and "Abspielen" starts it on the PC', async () => {
        await phone.getByRole('button', { name: 'Sternenstaub' }).click();
        await phone.getByRole('dialog', { name: 'Sternenstaub' }).getByRole('button', { name: 'Abspielen' }).click();
        await netflix.waitForURL(/\/watch\/80057281/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 10_000 });
    });

    await step('catalog: search from the phone', async () => {
        await phone.getByRole('button', { name: 'Zurück zur Übersicht' }).click();
        await phone.getByLabel('Suche').waitFor({ timeout: 15_000 });
        await phone.getByLabel('Suche').fill('Nachtfalter');
        await phone.getByLabel('Suche').press('Enter');
        await netflix.waitForURL(/\/search\?q=Nachtfalter/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('button', { name: 'Nachtfalter – Serie' }).waitFor({ timeout: 15_000 });
        // Titles Netflix showed before the results must be gone.
        await phone.getByRole('button', { name: 'Rotes Licht' }).waitFor({ state: 'detached', timeout: 5_000 });
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-search.png') });
        // The diagnosis is reachable from the settings on every page.
        await phone.getByRole('button', { name: 'Einstellungen' }).click();
        const settings = phone.getByRole('dialog', { name: 'Einstellungen' });
        await settings.getByRole('button', { name: 'Diagnose anzeigen' }).click();
        await settings.getByLabel('Diagnose').waitFor();
        assert.match(await settings.getByLabel('Diagnose').inputValue(), /"page": "search"[\s\S]*Nachtfalter – Serie/);
        await settings.getByRole('button', { name: 'Schließen' }).click();
    });

    await step('catalog: details with episodes, tapping an episode plays it', async () => {
        await phone.getByRole('button', { name: 'Nachtfalter – Serie' }).click();
        await phone.getByRole('button', { name: 'Details & Folgen' }).click();
        // The details open over the search results …
        await netflix.waitForURL(/\/search\?q=Nachtfalter&jbv=7002/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByText('Im Wald verschwindet ein Kind.').waitFor({ timeout: 15_000 });
        assert.equal(await phone.getByText('Allgemeine Beschreibung').count(), 0, 'cookie dialog taken for details');
        // Only the season's episodes, not the suggestions below them.
        await phone.getByRole('button', { name: /3\. Vergangenheit/ }).waitFor({ timeout: 10_000 });
        assert.equal(await phone.locator('.episodes li').count(), 3, 'suggestions listed as episodes');
        // "Nachtfalter" names two works; the year in the details picks the series.
        await phone.getByRole('link', { name: 'IMDb 8,7 von 10' }).waitFor({ timeout: 10_000 });
        await phone.getByText('Moth (2019–)').waitFor();
        // Netflix's season menu only exists while open; the phone still offers both seasons and switches.
        const season = phone.getByRole('combobox', { name: 'Staffel' });
        assert.deepEqual(await season.locator('option').allTextContents(), ['Staffel 1', 'Staffel 2']);
        await season.selectOption({ label: 'Staffel 2' });
        await phone.getByRole('button', { name: /1\. Neubeginn/ }).waitFor({ timeout: 15_000 });
        assert.equal(await netflix.locator('[data-uia="dropdown-toggle"]').textContent(), 'Staffel 2');
        assert.equal(await phone.locator('.episodes li').count(), 2);
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-detail.png') });
        // … so "Zurück" returns to them.
        await phone.getByRole('button', { name: 'Zurück', exact: true }).click();
        await netflix.waitForURL((u) => u.pathname === '/search' && !u.searchParams.has('jbv'), { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('heading', { name: 'Suchergebnisse' }).waitFor({ timeout: 10_000 });
        await phone.getByRole('button', { name: 'Nachtfalter – Serie' }).click();
        await phone.getByRole('button', { name: 'Details & Folgen' }).click();
        await phone.getByRole('button', { name: /2\. Lügen/ }).click({ timeout: 15_000 });
        await netflix.waitForURL(/\/watch\/90002/, { timeout: 10_000, waitUntil: 'commit' });
    });

    await step('catalog: leaving the player returns to the search results it was started from', async () => {
        await phone.getByRole('button', { name: 'Zurück zur Übersicht' }).click({ timeout: 15_000 });
        await netflix.waitForURL((u) => u.pathname === '/search' && u.searchParams.get('q') === 'Nachtfalter', { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('button', { name: 'Nachtfalter – Serie' }).waitFor({ timeout: 15_000 });
    });

    await step('catalog: section chips navigate the PC', async () => {
        await phone.getByRole('button', { name: 'Serien', exact: true }).click({ timeout: 15_000 });
        await netflix.waitForURL(/\/browse\/genre\/83/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('heading', { name: 'Serien-Tipps' }).waitFor({ timeout: 15_000 });
        // Netflix builds the billboard after the rows; the phone adds it without "load more".
        await phone.getByRole('region', { name: 'Empfehlung: Hafenlichter' }).waitFor({ timeout: 10_000 });
        // The chip of the section Netflix shows is highlighted, and only that one.
        await phone.locator('.chip[aria-current="page"]', { hasText: 'Serien' }).waitFor({ timeout: 10_000 });
        assert.equal(await phone.locator('.chip[aria-current="page"]').count(), 1);
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-sections.png') });
    });

    await step('closing Netflix shows "open Netflix", which reopens it', async () => {
        await netflix.close();
        await phone.getByRole('button', { name: 'Netflix am PC öffnen' }).click();
        // Depending on whether the new tab gets routed to the fake page, the phone shows the
        // profile gate or the generic "open on the PC" view; either means Netflix is back.
        await phone
            .getByText('Am PC geöffnet')
            .or(phone.getByRole('heading', { name: 'Wer schaut gerade?' }))
            .first()
            .waitFor({ timeout: 10_000 });
        // Tabs opened by the extension bypass the test's routing: depending on network access they show an
        // error page or the real netflix.com (which redirects to /login). Only check that a Netflix tab exists.
        const urls = await (await extensionWorker()).evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url));
        assert.ok(urls.some((u) => u && new URL(u).host === 'www.netflix.com'), urls.join(', '));
    });

    await step('wrong key is rejected', async () => {
        const intruder = await phoneCtx.newPage();
        await intruder.evaluate(() => localStorage.clear()).catch(() => {});
        await intruder.goto(pairingUrl.replace(`k=${config.key}`, 'k=ffffffffffffffffffffffffffffffff'));
        await intruder.getByText('Kopplung ungültig').first().waitFor({ timeout: 20_000 });
    });

    await step('update: a newer GitHub release shows in the popup and on the phone', async () => {
        githubRelease = {
            tag_name: 'v99.0.0',
            html_url: 'https://github.com/MacBuchi/netflix-remote/releases/tag/v99.0.0',
            assets: [{ browser_download_url: 'https://github.com/MacBuchi/netflix-remote/releases/download/v99.0.0/couch-remote-v99.0.0.zip' }],
        };
        const popup = await pc.newPage();
        await popup.goto(`chrome-extension://${extId}/popup.html`);
        await popup.getByText(`Version 99.0.0 verfügbar (installiert: ${installed})`).waitFor({ timeout: 10_000 });
        assert.match(await popup.locator('#update-zip').getAttribute('href'), /couch-remote-v99\.0\.0\.zip$/);
        await popup.close();
        const banner = phone.locator('.update-banner');
        await banner.getByText('Extension-Update 99.0.0').waitFor({ timeout: 15_000 });
        await banner.getByRole('button', { name: 'Hinweis ausblenden' }).click();
        await banner.waitFor({ state: 'detached' });
    });

    if (!BROWSER) await step('update: new files in the folder make the extension reload itself, the phone reconnects', async () => {
        const manifest = JSON.parse(originalManifest);
        await writeFile(join(EXT, 'manifest.json'), JSON.stringify({ ...manifest, version: '99.0.0' }, null, 4));
        // Opening the popup makes the extension look at once (otherwise within a minute).
        const popup = await pc.newPage();
        await popup.goto(`chrome-extension://${extId}/popup.html`).catch(() => {});
        await popup.waitForEvent('close', { timeout: 10_000 });
        const after = await pc.newPage();
        await after.goto(`chrome-extension://${extId}/popup.html`);
        assert.equal(await after.evaluate(() => chrome.runtime.getManifest().version), '99.0.0');
        // The phone reconnects to the reloaded extension and works as before.
        await phone.getByText('Test-Mac').waitFor();
        await phone.locator('.dot.connected').waitFor({ timeout: 30_000 });
        await phone.locator('.update-banner').waitFor({ state: 'detached' });
    });
} catch (e) {
    failed = true;
    console.error(e);
} finally {
    await writeFile(join(EXT, 'manifest.json'), originalManifest);
    await pc.close();
    await phoneBrowser.close();
    await hotelPhoneBrowser.close();
    mqttServer.close();
    aedes.close();
    web.close();
    peerServer.close?.();
}
console.log(failed ? '\nE2E FAILED' : '\nE2E passed');
process.exit(failed ? 1 : 0);
