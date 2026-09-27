// End-to-end test of the whole chain without Netflix or the internet:
//   phone app (built PWA) --WebRTC--> extension (offscreen → service worker → content → page) --> fake Netflix page
// A local PeerJS server stands in for the public broker; netflix.com is routed to tests/e2e/fake-netflix.html.
//
// Prerequisite: npm run build.  Run: npm run test:e2e
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { PeerServer } from 'peer';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const EXT = join(ROOT, 'extension/dist');
const REMOTE = join(ROOT, 'remote/dist');
const PEER_PORT = 9123;
const WEB_PORT = 9124;
const SHOTS = process.env.E2E_SCREENSHOTS;

const fakeNetflix = await readFile(join(import.meta.dirname, 'fake-netflix.html'), 'utf8');

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

const webrtcArgs = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
const pc = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...webrtcArgs],
});
const phoneBrowser = await chromium.launch({ args: webrtcArgs });

let failed = false;
const step = async (name, fn) => {
    process.stdout.write(`• ${name} … `);
    try {
        await fn();
        console.log('ok');
    } catch (e) {
        console.log('FAILED');
        throw e;
    }
};

try {
    await pc.route('https://www.netflix.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fakeNetflix }));

    const sw = pc.serviceWorkers()[0] ?? (await pc.waitForEvent('serviceworker'));
    const extId = new URL(sw.url()).host;

    let config;
    await step('configure extension via popup (local broker, local phone app)', async () => {
        const popup = await pc.newPage();
        await popup.goto(`chrome-extension://${extId}/popup.html`);
        await popup.locator('details summary').click();
        await popup.fill('#remote-url', `http://localhost:${WEB_PORT}/`);
        await popup.fill('#broker', `ws://localhost:${PEER_PORT}/`);
        await popup.click('#save');
        await popup.fill('#name', 'Test-Mac');
        await popup.locator('#name').dispatchEvent('change');
        await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: 'sw', type: 'getConfig' })).pcName === 'Test-Mac');
        await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Bereit'), null, { timeout: 15_000 });
        config = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'getConfig' }));
        assert.equal(config.pcName, 'Test-Mac');
        await popup.close();
    });

    const netflix = await pc.newPage();
    await netflix.goto('https://www.netflix.com/watch/80100172');

    const pairingUrl = `http://localhost:${WEB_PORT}/#${new URLSearchParams({ pc: config.peerId, k: config.key, n: config.pcName, b: config.broker })}`;
    const phoneCtx = await phoneBrowser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true });
    const phone = await phoneCtx.newPage();

    await step('phone pairs via QR link and connects over WebRTC', async () => {
        await phone.goto(pairingUrl);
        await phone.locator('.dot.connected').waitFor({ timeout: 20_000 });
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

    await step('closing Netflix shows "open Netflix", which reopens it', async () => {
        await netflix.close();
        await phone.getByRole('button', { name: 'Netflix am PC öffnen' }).click();
        await phone.getByText('Titel auswählen und starten').waitFor({ timeout: 10_000 });
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
    web.close();
    peerServer.close?.();
}
console.log(failed ? '\nE2E FAILED' : '\nE2E passed');
process.exit(failed ? 1 : 0);
