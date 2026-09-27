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
    /** Playback speed, 1 = normal. */
    | { type: 'player.setRate'; rate: number }
    | { type: 'player.exit' };

export type AppCommand =
    | { type: 'app.fullscreen'; on: boolean }
    | { type: 'app.openNetflix' }
    | { type: 'app.browse' };

export type CatalogSection = 'home' | 'series' | 'movies' | 'new' | 'mylist';

/** Netflix paths of the sections; the extension navigates there, the phone marks the current one. */
export const SECTION_URLS: Record<CatalogSection, string> = {
    home: '/browse',
    series: '/browse/genre/83',
    movies: '/browse/genre/34399',
    new: '/latest',
    mylist: '/browse/my-list',
};

/** The section a Netflix location (path + query) belongs to, or null (search, player …). */
export function sectionOf(location: string): CatalogSection | null {
    const path = location.split(/[?#]/)[0].replace(/\/+$/, '');
    const found = Object.entries(SECTION_URLS).find(([, url]) => url === path);
    return found ? (found[0] as CatalogSection) : null;
}

/** Film browser: read what Netflix shows on the PC and act on it. */
export type CatalogCommand =
    | { type: 'catalog.get'; offset: number; limit: number }
    | { type: 'catalog.loadMore' }
    | { type: 'catalog.play'; id: string }
    | { type: 'catalog.open'; id: string }
    | { type: 'catalog.episode'; index: number }
    | { type: 'catalog.season'; index: number }
    | { type: 'catalog.profile'; index: number }
    | { type: 'catalog.search'; q: string }
    | { type: 'catalog.nav'; section: CatalogSection }
    | { type: 'catalog.back' }
    | { type: 'catalog.debug' }
    /** Sound of the trailer previews on browse pages and in the details (not the player). */
    | { type: 'catalog.previewSound'; muted: boolean };

export type Command = PlayerCommand | AppCommand | CatalogCommand;

export interface CatalogItem {
    /** Netflix video id (movie or show). */
    id: string;
    name: string;
    img: string | null;
    /** Watch progress 0..1, if Netflix shows one. */
    progress: number | null;
}

export interface CatalogRow {
    title: string;
    items: CatalogItem[];
}

export interface Profile {
    index: number;
    name: string;
    img: string | null;
}

export interface Episode {
    index: number;
    label: string;
    title: string;
    synopsis: string;
    img: string | null;
    progress: number | null;
}

export interface TitleDetail {
    id: string | null;
    title: string;
    synopsis: string;
    img: string | null;
    seasons: string[];
    season: number;
    episodes: Episode[];
}

export interface Catalog {
    page: PageKind;
    rows: CatalogRow[];
    /** Number of rows available on the PC; rows beyond offset+limit can be fetched later. */
    totalRows: number;
    profiles: Profile[];
    detail: TitleDetail | null;
    /** The large recommendation on top of browse pages; missing from extensions before 2.2.4. */
    billboard?: Billboard | null;
    /** Whether the trailer preview is muted; null when no preview plays (missing before 2.2.7). */
    previewMuted?: boolean | null;
}

/** Netflix's "billboard": the full-width recommendation whose trailer starts on the PC. */
export interface Billboard {
    id: string;
    title: string;
    synopsis: string;
    /** Wide background image. */
    img: string | null;
    /** Title treatment (the title as a logo image), if Netflix shows one. */
    logo: string | null;
}

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
    /** Playback speed; missing from extensions before 2.2.7. */
    playbackRate?: number;
}

export type PageKind = 'none' | 'profiles' | 'browse' | 'title' | 'search' | 'watch' | 'login' | 'other';

export interface RemoteState {
    page: PageKind;
    /** Path and query of the Netflix tab, so the phone notices navigation. */
    location: string;
    fullscreen: boolean;
    player: PlayerState | null;
}

// Phone -> PC
export interface HelloMsg {
    v: number;
    type: 'hello';
    key: string;
    device: string;
    /** Random per app start; lets the PC see that a direct and a relay link belong to the same phone. */
    phoneId: string;
}
export interface RequestMsg {
    v: number;
    type: 'request';
    id: string;
    cmd: Command;
}
/** Relay keep-alive (the relay has no connection state) and polite goodbye. */
export interface PingMsg {
    v: number;
    type: 'ping' | 'bye';
}
export type PhoneMsg = HelloMsg | RequestMsg | PingMsg;

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
    data?: unknown;
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
    /** Payload for queries such as catalog.get. */
    data?: unknown;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown, max = 200): x is string => typeof x === 'string' && x.length <= max;

const isInt = (x: unknown, min: number, max: number): x is number =>
    typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
const CATALOG_SECTIONS: CatalogSection[] = ['home', 'series', 'movies', 'new', 'mylist'];

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
        case 'catalog.loadMore':
        case 'catalog.back':
        case 'catalog.debug':
            return { type: x.type };
        case 'catalog.get':
            return isInt(x.offset, 0, 500) && isInt(x.limit, 1, 20)
                ? { type: x.type, offset: x.offset, limit: x.limit }
                : null;
        case 'catalog.play':
        case 'catalog.open':
            return typeof x.id === 'string' && /^\d{1,12}$/.test(x.id) ? { type: x.type, id: x.id } : null;
        case 'catalog.episode':
        case 'catalog.season':
        case 'catalog.profile':
            return isInt(x.index, 0, 500) ? { type: x.type, index: x.index } : null;
        case 'catalog.search':
            return isStr(x.q, 100) && x.q.trim() ? { type: x.type, q: x.q.trim() } : null;
        case 'catalog.previewSound':
            return typeof x.muted === 'boolean' ? { type: x.type, muted: x.muted } : null;
        case 'catalog.nav':
            return typeof x.section === 'string' && CATALOG_SECTIONS.includes(x.section as CatalogSection)
                ? { type: x.type, section: x.section as CatalogSection }
                : null;
        case 'player.seekBy':
            return isNum(x.ms) && Math.abs(x.ms) <= MAX_SEEK_MS ? { type: x.type, ms: Math.round(x.ms) } : null;
        case 'player.seekTo':
            return isNum(x.ms) && x.ms >= 0 && x.ms <= MAX_SEEK_MS ? { type: x.type, ms: Math.round(x.ms) } : null;
        case 'player.setVolume':
            return isNum(x.volume) ? { type: x.type, volume: Math.min(1, Math.max(0, x.volume)) } : null;
        case 'player.setMuted':
            return typeof x.muted === 'boolean' ? { type: x.type, muted: x.muted } : null;
        case 'player.setRate':
            return isNum(x.rate) && x.rate >= 0.25 && x.rate <= 3 ? { type: x.type, rate: Math.round(x.rate * 100) / 100 } : null;
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
        const phoneId = isStr(x.phoneId, 64) && x.phoneId ? x.phoneId : 'unknown';
        return { v: x.v, type: 'hello', key: x.key, device: x.device, phoneId };
    }
    if (x.type === 'ping' || x.type === 'bye') return { v: x.v, type: x.type };
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
    /** MQTT relay URL for networks that block direct connections; empty means the default relay. */
    relay: string;
}

/** Link encoded in the QR code. The secret lives in the hash so it never reaches the web server. */
export function buildPairingUrl(remoteUrl: string, p: Pairing): string {
    const params = new URLSearchParams({ pc: p.peerId, k: p.key, n: p.name });
    if (p.broker) params.set('b', p.broker);
    if (p.relay) params.set('r', p.relay);
    return `${remoteUrl.split('#')[0]}#${params.toString()}`;
}

export function parsePairingHash(hash: string): Pairing | null {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const peerId = params.get('pc');
    const key = params.get('k');
    if (!peerId || !key || !/^[A-Za-z0-9_-]{8,64}$/.test(peerId) || key.length < 16) return null;
    return {
        peerId,
        key,
        name: params.get('n') || 'Netflix-PC',
        broker: params.get('b') || '',
        relay: params.get('r') || '',
    };
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
