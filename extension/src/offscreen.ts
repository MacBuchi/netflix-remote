// Offscreen document: MV3 service workers have no RTCPeerConnection, so the
// WebRTC link to the phones lives here. It is independent of the Netflix tab,
// so phones stay connected across reloads and navigation.
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
    type RemoteState,
} from '../../shared/protocol';
import type { Config, OffscreenMsg, OffscreenStatus, SwMsg } from './messages';

const AUTH_TIMEOUT_MS = 10_000;
/** Errors after which the peer must be recreated rather than just reconnected to the broker. */
const FATAL_ERRORS = new Set(['unavailable-id', 'invalid-id', 'server-error', 'socket-error', 'ssl-unavailable']);

let config: Config;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
const clients = new Map<DataConnection, string>();
let lastState: RemoteState | null = null;
let lastStateJson = '';
const status: OffscreenStatus = { broker: 'connecting', error: null, devices: [] };

function toSw<T>(msg: SwMsg): Promise<T> {
    return chrome.runtime.sendMessage(msg);
}

function send(conn: DataConnection, msg: PcMsg) {
    if (conn.open) void conn.send(msg);
}

function backoffMs() {
    return Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
}

function connect() {
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
            restartTimer = setTimeout(connect, backoffMs());
        }
    });
}

function handleConnection(conn: DataConnection) {
    let authed = false;
    const authTimer = setTimeout(() => !authed && conn.close(), AUTH_TIMEOUT_MS);

    conn.on('data', async (raw) => {
        const msg = parsePhoneMsg(raw);
        if (!msg) {
            send(conn, { v: PROTOCOL_VERSION, type: 'error', code: 'bad-request', message: 'Unbekannte Nachricht' });
            return;
        }
        if (!authed) {
            if (msg.type !== 'hello') return conn.close();
            if (msg.v !== PROTOCOL_VERSION) {
                send(conn, { v: PROTOCOL_VERSION, type: 'error', code: 'version', message: 'Bitte Remote-App neu laden' });
                return setTimeout(() => conn.close(), 200);
            }
            if (msg.key !== config.key) {
                send(conn, { v: PROTOCOL_VERSION, type: 'error', code: 'auth', message: 'Kopplung ungültig – bitte QR-Code neu scannen' });
                return setTimeout(() => conn.close(), 200);
            }
            authed = true;
            clearTimeout(authTimer);
            clients.set(conn, msg.device);
            send(conn, { v: PROTOCOL_VERSION, type: 'welcome', pcName: config.pcName });
            if (lastState) send(conn, { v: PROTOCOL_VERSION, type: 'state', state: lastState });
            clientsChanged();
            return;
        }
        if (msg.type === 'request') {
            let result: CommandResult;
            try {
                result = (await toSw<CommandResult>({ target: 'sw', type: 'command', cmd: msg.cmd })) ?? { ok: false };
            } catch (e) {
                result = { ok: false, error: String(e) };
            }
            send(conn, { v: PROTOCOL_VERSION, type: 'response', re: msg.id, ...result });
        }
    });

    const drop = () => {
        clearTimeout(authTimer);
        if (clients.delete(conn)) clientsChanged();
    };
    conn.on('close', drop);
    conn.on('error', drop);
}

function clientsChanged() {
    status.devices = [...clients.values()];
    void toSw({ target: 'sw', type: 'clients', count: clients.size }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg: OffscreenMsg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return;
    switch (msg.type) {
        case 'state': {
            const json = JSON.stringify(msg.state);
            if (json === lastStateJson) return;
            lastState = msg.state;
            lastStateJson = json;
            for (const conn of clients.keys()) send(conn, { v: PROTOCOL_VERSION, type: 'state', state: msg.state });
            return;
        }
        case 'status':
            sendResponse(status);
            return;
    }
});

toSw<Config>({ target: 'sw', type: 'getConfig' }).then((c) => {
    config = c;
    connect();
});
