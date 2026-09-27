// Messages exchanged between the phone (remote app) and the Chrome extension
// over the WebRTC data channel. Everything the phone sends is validated here
// before the extension acts on it.

export const PROTOCOL_VERSION = 1;

export type PlayerCommand =
    | { type: 'player.play' }
    | { type: 'player.pause' }
    | { type: 'player.toggle' }
    | { type: 'player.seekBy'; ms: number }
    | { type: 'player.seekTo'; ms: number }
    | { type: 'player.setVolume'; volume: number }
    | { type: 'player.setMuted'; muted: boolean }
    | { type: 'player.skip' }
    | { type: 'player.nextEpisode' }
    | { type: 'player.setAudioTrack'; id: string }
    | { type: 'player.setTextTrack'; id: string }
    | { type: 'player.exit' };

export type AppCommand =
    | { type: 'app.fullscreen'; on: boolean }
    | { type: 'app.openNetflix' }
    | { type: 'app.browse' };

export type Command = PlayerCommand | AppCommand;

export interface Track {
    id: string;
    label: string;
}

export interface PlayerState {
    title: string;
    subtitle: string;
    positionMs: number;
    durationMs: number;
    paused: boolean;
    volume: number;
    muted: boolean;
    /** Label of a visible "skip intro / recap / credits" button, if any. */
    skipLabel: string | null;
    canNext: boolean;
    audioTracks: Track[];
    audioTrackId: string | null;
    textTracks: Track[];
    textTrackId: string | null;
}

export type PageKind = 'none' | 'profiles' | 'browse' | 'title' | 'search' | 'watch' | 'login' | 'other';

export interface RemoteState {
    page: PageKind;
    fullscreen: boolean;
    player: PlayerState | null;
}

// Phone -> PC
export interface HelloMsg {
    v: number;
    type: 'hello';
    key: string;
    device: string;
}
export interface RequestMsg {
    v: number;
    type: 'request';
    id: string;
    cmd: Command;
}
export type PhoneMsg = HelloMsg | RequestMsg;

// PC -> phone
export interface WelcomeMsg {
    v: number;
    type: 'welcome';
    pcName: string;
}
export interface ResponseMsg {
    v: number;
    type: 'response';
    re: string;
    ok: boolean;
    error?: string;
}
export interface StateMsg {
    v: number;
    type: 'state';
    state: RemoteState;
}
export interface ErrorMsg {
    v: number;
    type: 'error';
    code: 'auth' | 'version' | 'bad-request';
    message: string;
}
export type PcMsg = WelcomeMsg | ResponseMsg | StateMsg | ErrorMsg;

export interface CommandResult {
    ok: boolean;
    error?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown, max = 200): x is string => typeof x === 'string' && x.length <= max;

const MAX_SEEK_MS = 24 * 60 * 60 * 1000;

/** Returns a sanitized command, or null when the input is not an allowed command. */
export function parseCommand(x: unknown): Command | null {
    if (!isObj(x) || typeof x.type !== 'string') return null;
    switch (x.type) {
        case 'player.play':
        case 'player.pause':
        case 'player.toggle':
        case 'player.skip':
        case 'player.nextEpisode':
        case 'player.exit':
        case 'app.openNetflix':
        case 'app.browse':
            return { type: x.type };
        case 'player.seekBy':
            return isNum(x.ms) && Math.abs(x.ms) <= MAX_SEEK_MS ? { type: x.type, ms: Math.round(x.ms) } : null;
        case 'player.seekTo':
            return isNum(x.ms) && x.ms >= 0 && x.ms <= MAX_SEEK_MS ? { type: x.type, ms: Math.round(x.ms) } : null;
        case 'player.setVolume':
            return isNum(x.volume) ? { type: x.type, volume: Math.min(1, Math.max(0, x.volume)) } : null;
        case 'player.setMuted':
            return typeof x.muted === 'boolean' ? { type: x.type, muted: x.muted } : null;
        case 'player.setAudioTrack':
        case 'player.setTextTrack':
            return isStr(x.id) ? { type: x.type, id: x.id } : null;
        case 'app.fullscreen':
            return typeof x.on === 'boolean' ? { type: x.type, on: x.on } : null;
        default:
            return null;
    }
}

/** Parses a raw data-channel payload from the phone. */
export function parsePhoneMsg(raw: unknown): PhoneMsg | null {
    let x = raw;
    if (typeof x === 'string') {
        if (x.length > 10_000) return null;
        try {
            x = JSON.parse(x);
        } catch {
            return null;
        }
    }
    if (!isObj(x) || !isNum(x.v)) return null;
    if (x.type === 'hello' && isStr(x.key) && isStr(x.device)) {
        return { v: x.v, type: 'hello', key: x.key, device: x.device };
    }
    if (x.type === 'request' && isStr(x.id, 64)) {
        const cmd = parseCommand(x.cmd);
        return cmd ? { v: x.v, type: 'request', id: x.id, cmd } : null;
    }
    return null;
}

// ---- Pairing ---------------------------------------------------------------

/** Where the phone finds the PC: which PeerJS broker, which peer id, and the shared secret. */
export interface Pairing {
    peerId: string;
    key: string;
    name: string;
    /** Broker URL like "wss://0.peerjs.com:443/"; empty means the PeerJS default cloud. */
    broker: string;
}

/** Link encoded in the QR code. The secret lives in the hash so it never reaches the web server. */
export function buildPairingUrl(remoteUrl: string, p: Pairing): string {
    const params = new URLSearchParams({ pc: p.peerId, k: p.key, n: p.name });
    if (p.broker) params.set('b', p.broker);
    return `${remoteUrl.split('#')[0]}#${params.toString()}`;
}

export function parsePairingHash(hash: string): Pairing | null {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const peerId = params.get('pc');
    const key = params.get('k');
    if (!peerId || !key || !/^[A-Za-z0-9_-]{8,64}$/.test(peerId) || key.length < 16) return null;
    return { peerId, key, name: params.get('n') || 'Netflix-PC', broker: params.get('b') || '' };
}

export interface BrokerOptions {
    host: string;
    port: number;
    path: string;
    secure: boolean;
}

/** Converts a broker URL into PeerJS options; returns {} (PeerJS cloud) for an empty string. */
export function brokerOptions(broker: string): Partial<BrokerOptions> {
    if (!broker) return {};
    const url = new URL(broker);
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    return {
        host: url.hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: url.pathname || '/',
        secure,
    };
}

export function randomId(bytes = 16): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatTime(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
