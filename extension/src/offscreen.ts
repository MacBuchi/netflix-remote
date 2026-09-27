// Offscreen document: MV3 service workers have no RTCPeerConnection, so the
// links to the phones live here. It is independent of the Netflix tab, so
// phones stay connected across reloads and navigation.
//
// Phones reach the PC two ways at once:
//   direct – WebRTC data channel (PeerJS), the normal case
//   relay  – end-to-end encrypted messages through an MQTT broker, for
//            networks that block direct connections (hotel/guest Wi-Fi)
// Both feed the same session logic below.
//
// Only chrome.runtime is available in offscreen documents; everything else
// goes through the service worker.

import Peer, { type DataConnection } from 'peerjs';
import {
    PROTOCOL_VERSION,
    brokerOptions,
    parsePhoneMsg,
    type CommandResult,
    type PcMsg,
    type PhoneMsg,
    type RemoteState,
} from '../../shared/protocol';
import { DEFAULT_RELAY, RelayChannel, pcTopic, phoneTopic, relayKeys, type Envelope } from '../../shared/relay';
import type { Config, OffscreenMsg, OffscreenStatus, SwMsg } from './messages';

const AUTH_TIMEOUT_MS = 10_000;
/** Relay sessions have no connection to watch; phones ping every 10 s. */
const RELAY_IDLE_MS = 35_000;
/** Errors after which the peer must be recreated rather than just reconnected to the broker. */
const FATAL_ERRORS = new Set(['unavailable-id', 'invalid-id', 'server-error', 'socket-error', 'ssl-unavailable']);

interface Session {
    kind: 'direct' | 'relay';
    authed: boolean;
    phoneId: string;
    device: string;
    lastSeen: number;
    send(msg: PcMsg): void;
    close(): void;
}

let config: Config;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
const sessions = new Set<Session>();
const relaySessions = new Map<string, Session>();
let relay: RelayChannel | null = null;
let lastState: RemoteState | null = null;
let lastStateJson = '';
const status: OffscreenStatus = { broker: 'connecting', relay: 'connecting', error: null, devices: [] };

function toSw<T>(msg: SwMsg): Promise<T> {
    return chrome.runtime.sendMessage(msg);
}

function backoffMs() {
    return Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
}

// ---- sessions (transport independent) ------------------------------------------

function hasDirect(phoneId: string) {
    for (const s of sessions) if (s.kind === 'direct' && s.authed && s.phoneId === phoneId) return true;
    return false;
}

/** Relay sessions only get state while the same phone has no working direct link. */
function wantsState(s: Session) {
    return s.authed && (s.kind === 'direct' || !hasDirect(s.phoneId));
}

function sendState(s: Session) {
    if (lastState && wantsState(s)) s.send({ v: PROTOCOL_VERSION, type: 'state', state: lastState });
}

async function handlePhoneMsg(s: Session, msg: PhoneMsg | null) {
    s.lastSeen = Date.now();
    if (!msg) {
        s.send({ v: PROTOCOL_VERSION, type: 'error', code: 'bad-request', message: 'Unbekannte Nachricht' });
        return;
    }
    if (msg.type === 'hello') {
        if (msg.v !== PROTOCOL_VERSION) {
            s.send({ v: PROTOCOL_VERSION, type: 'error', code: 'version', message: 'Bitte Remote-App neu laden' });
            return setTimeout(() => s.close(), 200);
        }
        if (msg.key !== config.key) {
            s.send({ v: PROTOCOL_VERSION, type: 'error', code: 'auth', message: 'Kopplung ungültig – bitte QR-Code neu scannen' });
            return setTimeout(() => s.close(), 200);
        }
        const wasAuthed = s.authed;
        s.authed = true;
        s.phoneId = msg.phoneId;
        s.device = msg.device;
        s.send({ v: PROTOCOL_VERSION, type: 'welcome', pcName: config.pcName });
        sendState(s);
        if (!wasAuthed) sessionsChanged();
        return;
    }
    if (!s.authed) return s.close();
    switch (msg.type) {
        case 'request': {
            let result: CommandResult;
            try {
                result = (await toSw<CommandResult>({ target: 'sw', type: 'command', cmd: msg.cmd })) ?? { ok: false };
            } catch (e) {
                result = { ok: false, error: String(e) };
            }
            s.send({ v: PROTOCOL_VERSION, type: 'response', re: msg.id, ...result });
            return;
        }
        case 'ping':
            // Relay messages can get lost; a ping is a good moment to resend the state.
            if (s.kind === 'relay') sendState(s);
            return;
        case 'bye':
            return s.close();
    }
}

function dropSession(s: Session) {
    if (!sessions.delete(s)) return;
    if (s.kind === 'relay') relaySessions.delete(s.phoneId);
    if (s.authed) sessionsChanged();
}

function sessionsChanged() {
    const phones = new Map<string, string>();
    for (const s of sessions) {
        if (!s.authed) continue;
        const label = s.kind === 'relay' && !hasDirect(s.phoneId) ? `${s.device} (über Relay)` : s.device;
        if (!phones.has(s.phoneId) || s.kind === 'direct') phones.set(s.phoneId, label);
    }
    status.devices = [...phones.values()];
    void toSw({ target: 'sw', type: 'clients', count: phones.size }).catch(() => {});
}

// ---- direct: WebRTC via PeerJS ------------------------------------------------------

function connectPeer() {
    clearTimeout(restartTimer);
    status.broker = 'connecting';
    const p = new Peer(config.peerId, { ...brokerOptions(config.broker), debug: 1 });
    let everOpened = false;

    p.on('open', () => {
        everOpened = true;
        failures = 0;
        status.broker = 'online';
        status.error = null;
    });
    p.on('connection', handleConnection);
    // Lost the broker only; existing phone connections keep working meanwhile.
    p.on('disconnected', () => {
        status.broker = 'offline';
        restartTimer = setTimeout(() => {
            if (!p.destroyed && p.disconnected) p.reconnect();
        }, backoffMs());
    });
    p.on('error', (err) => {
        status.error = err.type;
        if (FATAL_ERRORS.has(err.type) || !everOpened) {
            status.broker = 'offline';
            p.destroy();
            clearTimeout(restartTimer);
            restartTimer = setTimeout(connectPeer, backoffMs());
        }
    });
}

function handleConnection(conn: DataConnection) {
    const s: Session = {
        kind: 'direct',
        authed: false,
        phoneId: '',
        device: '',
        lastSeen: Date.now(),
        send: (msg) => {
            if (conn.open) void conn.send(msg);
        },
        close: () => conn.close(),
    };
    sessions.add(s);
    const authTimer = setTimeout(() => !s.authed && conn.close(), AUTH_TIMEOUT_MS);
    conn.on('data', (raw) => void handlePhoneMsg(s, parsePhoneMsg(raw)));
    const drop = () => {
        clearTimeout(authTimer);
        dropSession(s);
    };
    conn.on('close', drop);
    conn.on('error', drop);
}

// ---- relay: encrypted MQTT ------------------------------------------------------------

async function startRelay() {
    const keys = await relayKeys(config.peerId, config.key);
    relay = new RelayChannel(
        config.relay || DEFAULT_RELAY,
        keys,
        pcTopic(keys),
        (env) => onRelayEnvelope(env, keys),
        (state) => (status.relay = state),
    );
    relay.start();
    setInterval(() => {
        const now = Date.now();
        for (const s of relaySessions.values()) if (now - s.lastSeen > RELAY_IDLE_MS) dropSession(s);
    }, 5000);
}

function onRelayEnvelope(env: Envelope, keys: Awaited<ReturnType<typeof relayKeys>>) {
    const from = typeof env.from === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(env.from) ? env.from : null;
    if (!from) return;
    let s = relaySessions.get(from);
    if (!s) {
        const topic = phoneTopic(keys, from);
        s = {
            kind: 'relay',
            authed: false,
            phoneId: from,
            device: '',
            lastSeen: Date.now(),
            send: (msg) => void relay?.publish(topic, { msg }),
            close: () => dropSession(s!),
        };
        sessions.add(s);
        relaySessions.set(from, s);
    }
    void handlePhoneMsg(s, parsePhoneMsg(env.msg));
}

// ---- wiring --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: OffscreenMsg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return;
    switch (msg.type) {
        case 'state': {
            const json = JSON.stringify(msg.state);
            if (json === lastStateJson) return;
            lastState = msg.state;
            lastStateJson = json;
            for (const s of sessions) sendState(s);
            return;
        }
        case 'status':
            sendResponse(status);
            return;
    }
});

toSw<Config>({ target: 'sw', type: 'getConfig' }).then((c) => {
    config = c;
    connectPeer();
    void startRelay();
});
