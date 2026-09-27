import QRCode from 'qrcode';
import { buildPairingUrl } from '../../shared/protocol';
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
    });
    await QRCode.toCanvas($('qr'), pairingUrl, { width: 216, margin: 0, errorCorrectionLevel: 'M' });
    setField('name', config.pcName);
    setField('remote-url', config.remoteUrl);
    setField('broker', config.broker);
}

const BROKER_TEXT: Record<OffscreenStatus['broker'], string> = {
    connecting: 'Verbinde mit Vermittlungs-Server …',
    online: 'Bereit – wartet auf das Handy',
    offline: 'Vermittlungs-Server nicht erreichbar, neuer Versuch läuft …',
};

async function pollStatus() {
    const s = await chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'status' } satisfies OffscreenMsg)
        .catch(() => undefined) as OffscreenStatus | undefined;
    if (!s) return;
    $('dot').className = `dot ${s.broker}`;
    $('status').textContent = BROKER_TEXT[s.broker] + (s.error && s.broker !== 'online' ? ` (${s.error})` : '');
    $('devices').textContent = s.devices.length ? `Verbunden: ${s.devices.join(', ')}` : '';
}

/** Saves all fields together, so saving one never resets another that is still being edited. */
async function save() {
    const patch = {
        pcName: $<HTMLInputElement>('name').value.trim() || 'Netflix-PC',
        remoteUrl: $<HTMLInputElement>('remote-url').value.trim() || DEFAULT_REMOTE_URL,
        broker: $<HTMLInputElement>('broker').value.trim(),
    };
    await render(await toSw<Config>({ target: 'sw', type: 'updateConfig', patch }));
}

document.addEventListener('DOMContentLoaded', async () => {
    await render(await toSw<Config>({ target: 'sw', type: 'getConfig' }));
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
