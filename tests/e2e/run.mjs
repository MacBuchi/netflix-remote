// End-to-end test of the whole chain without Netflix or the internet:
//   phone app (built PWA) --WebRTC--> extension (offscreen → service worker → content → page) --> fake Netflix page
// A local PeerJS server stands in for the public broker; netflix.com is routed to tests/e2e/fake-netflix.html.
//
// Prerequisite: npm run build.  Run: npm run test:e2e
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

/** A colored poster named after the image URL's `t` parameter (the fake page puts the title there). */
function posterSvg(url) {
    const title = new URL(url).searchParams.get('t') ?? '';
    const hue = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 200);
    const esc = title.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
        <defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,14%)"/></linearGradient></defs>
        <rect width="320" height="180" fill="url(#g)"/>
        <text x="160" y="100" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" text-anchor="middle">${esc}</text></svg>`;
}
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

const webrtcArgs = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
const pc = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...webrtcArgs],
});
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

    const sw = pc.serviceWorkers()[0] ?? (await pc.waitForEvent('serviceworker'));
    const extId = new URL(sw.url()).host;

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

    const pairingUrl = `http://localhost:${WEB_PORT}/#${new URLSearchParams({ pc: config.peerId, k: config.key, n: config.pcName, b: config.broker, r: config.relay })}`;
    const phoneCtx = await phoneBrowser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true });
    await phoneCtx.route('https://*.nflxso.net/**', cdn);
    const phone = await phoneCtx.newPage();
    watched.phone = phone;

    await step('phone pairs via QR link and ends up on the direct WebRTC link', async () => {
        await phone.goto(pairingUrl);
        await phone.locator('.dot.connected').waitFor({ timeout: 20_000 });
        await phone.locator('.via', { hasText: 'Direkt' }).waitFor({ timeout: 20_000 });
        assert.equal(await phone.locator('.pc-name').textContent(), 'Test-Mac');
        assert.equal(new URL(phone.url()).hash, '', 'secret removed from address bar');
    });

    await step('player state reaches the phone', async () => {
        await phone.getByRole('heading', { name: 'Dark' }).waitFor({ timeout: 10_000 });
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
        await hotel.getByRole('heading', { name: 'Dark' }).waitFor({ timeout: 15_000 });
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
        await phone.getByRole('button', { name: 'Stranger Things' }).waitFor();
        await phone.getByRole('heading', { name: 'Derzeit beliebt' }).waitFor();
        const progress = phone.getByRole('button', { name: 'Stranger Things' }).locator('.progress div');
        assert.equal(await progress.getAttribute('style'), 'width: 70%;');
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

    await step('catalog: tapping a title and "Abspielen" starts it on the PC', async () => {
        await phone.getByRole('button', { name: 'Stranger Things' }).click();
        await phone.getByRole('dialog', { name: 'Stranger Things' }).getByRole('button', { name: 'Abspielen' }).click();
        await netflix.waitForURL(/\/watch\/80057281/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 10_000 });
    });

    await step('catalog: search from the phone', async () => {
        await phone.getByRole('button', { name: 'Zurück zur Übersicht' }).click();
        await phone.getByLabel('Suche').waitFor({ timeout: 15_000 });
        await phone.getByLabel('Suche').fill('Dark');
        await phone.getByLabel('Suche').press('Enter');
        await netflix.waitForURL(/\/search\?q=Dark/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('button', { name: 'Dark – Serie' }).waitFor({ timeout: 15_000 });
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-search.png') });
    });

    await step('catalog: details with episodes, tapping an episode plays it', async () => {
        await phone.getByRole('button', { name: 'Dark – Serie' }).click();
        await phone.getByRole('button', { name: 'Details & Folgen' }).click();
        await netflix.waitForURL(/jbv=7002/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByText('Ein Kind verschwindet.').waitFor({ timeout: 15_000 });
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'remote-detail.png') });
        await phone.getByRole('button', { name: /2\. Lügen/ }).click();
        await netflix.waitForURL(/\/watch\/90002/, { timeout: 10_000, waitUntil: 'commit' });
    });

    await step('catalog: section chips navigate the PC', async () => {
        await phone.getByRole('button', { name: 'Zurück zur Übersicht' }).click();
        await phone.getByRole('button', { name: 'Serien', exact: true }).click({ timeout: 15_000 });
        await netflix.waitForURL(/\/browse\/genre\/83/, { timeout: 10_000, waitUntil: 'commit' });
        await phone.getByRole('heading', { name: 'Serien-Tipps' }).waitFor({ timeout: 15_000 });
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
        const urls = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url));
        assert.ok(urls.some((u) => u && new URL(u).host === 'www.netflix.com'), urls.join(', '));
    });

    await step('wrong key is rejected', async () => {
        const intruder = await phoneCtx.newPage();
        await intruder.evaluate(() => localStorage.clear()).catch(() => {});
        await intruder.goto(pairingUrl.replace(`k=${config.key}`, 'k=ffffffffffffffffffffffffffffffff'));
        await intruder.getByText('Kopplung ungültig').first().waitFor({ timeout: 20_000 });
    });
} catch (e) {
    failed = true;
    console.error(e);
} finally {
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
