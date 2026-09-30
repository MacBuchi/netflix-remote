import QRCode from 'qrcode';
import { buildPairingUrl, type ExtensionUpdate } from '../../shared/protocol';
import { DEFAULT_REMOTE_URL, type Config, type OffscreenMsg, type OffscreenStatus, type SwMsg } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function toSw<T>(msg: SwMsg): Promise<T> {
    return chrome.runtime.sendMessage(msg);
}

let pairingUrl = '';

/** Leaves the field alone while the user is typing in it. */
function setField(id: string, value: string) {
    const input = $<HTMLInputElement>(id);
    if (document.activeElement !== input) input.value = value;
}

async function render(config: Config) {
    pairingUrl = buildPairingUrl(config.remoteUrl, {
        peerId: config.peerId,
        key: config.key,
        name: config.pcName,
        broker: config.broker,
        relay: config.relay,
    });
    await QRCode.toCanvas($('qr'), pairingUrl, { width: 216, margin: 0, errorCorrectionLevel: 'M' });
    setField('name', config.pcName);
    setField('remote-url', config.remoteUrl);
    setField('broker', config.broker);
    setField('relay', config.relay);
}

const LINK_TEXT: Record<OffscreenStatus['broker'], string> = {
    connecting: 'verbinde …',
    online: 'bereit',
    offline: 'nicht erreichbar, neuer Versuch läuft',
};

async function pollStatus() {
    const s = await chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'status' } satisfies OffscreenMsg)
        .catch(() => undefined) as OffscreenStatus | undefined;
    if (!s) return;
    const ready = s.broker === 'online' || s.relay === 'online';
    $('dot').className = `dot ${ready ? 'online' : s.broker === 'connecting' || s.relay === 'connecting' ? '' : 'offline'}`;
    $('status').textContent = ready ? 'Bereit – wartet auf das Handy' : 'Verbinde …';
    $('links').textContent =
        `Direkt: ${LINK_TEXT[s.broker]}${s.error && s.broker !== 'online' ? ` (${s.error})` : ''} · Relay: ${LINK_TEXT[s.relay]}`;
    $('devices').textContent = s.devices.length ? `Verbunden: ${s.devices.join(', ')}` : '';
}

async function showUpdate() {
    const update = await toSw<ExtensionUpdate | null>({ target: 'sw', type: 'getUpdate' }).catch(() => null);
    if (!update) return;
    $('update-title').textContent = `Version ${update.latest} verfügbar (installiert: ${update.current})`;
    const zip = $<HTMLAnchorElement>('update-zip');
    if (update.zip) zip.href = update.zip;
    else zip.hidden = true;
    $<HTMLAnchorElement>('update-notes').href = update.page;
    $('update').hidden = false;
}

/** Saves all fields together, so saving one never resets another that is still being edited. */
async function save() {
    const patch = {
        pcName: $<HTMLInputElement>('name').value.trim() || 'Netflix-PC',
        remoteUrl: $<HTMLInputElement>('remote-url').value.trim() || DEFAULT_REMOTE_URL,
        broker: $<HTMLInputElement>('broker').value.trim(),
        relay: $<HTMLInputElement>('relay').value.trim(),
    };
    await render(await toSw<Config>({ target: 'sw', type: 'updateConfig', patch }));
}

document.addEventListener('DOMContentLoaded', async () => {
    $('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
    await render(await toSw<Config>({ target: 'sw', type: 'getConfig' }));
    void showUpdate();
    void pollStatus();
    setInterval(pollStatus, 1000);

    $('name').addEventListener('change', () => void save());
    $('copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(pairingUrl);
        $('copy').textContent = 'Kopiert ✓';
    });
    $('reset').addEventListener('click', async () => {
        if (!confirm('Neuen Schlüssel erzeugen? Bereits gekoppelte Handys müssen den QR-Code neu scannen.')) return;
        await render(await toSw<Config>({ target: 'sw', type: 'resetPairing' }));
    });
    $('save').addEventListener('click', () => void save());
});
