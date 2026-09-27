// Connection from the phone to one paired PC. Two links are tried in parallel:
//   direct – WebRTC data channel (PeerJS): fastest, stays in the local network
//   relay  – end-to-end encrypted messages through a public MQTT broker: works
//            where the Wi-Fi blocks devices from reaching each other (hotels)
// Whichever is up first is used; when the direct link comes up it takes over,
// when it drops the relay carries on. Both reconnect on their own.

import Peer, { type DataConnection } from 'peerjs';
import {
    PROTOCOL_VERSION,
    brokerOptions,
    randomId,
    type Command,
    type CommandResult,
    type Pairing,
    type PcMsg,
    type PhoneMsg,
    type RemoteState,
} from '../../shared/protocol';
import { DEFAULT_RELAY, RelayChannel, pcTopic, phoneTopic, relayKeys, type RelayKeys } from '../../shared/relay';

export type ConnStatus = 'connecting' | 'connected' | 'pc-offline' | 'blocked' | 'offline' | 'auth-failed';
export type Via = 'direct' | 'relay';

export interface ClientSnapshot {
    status: ConnStatus;
    via: Via | null;
    pcName: string;
    state: RemoteState | null;
    error: string | null;
}

const REQUEST_TIMEOUT_MS = 6000;
const RELAY_TICK_MS = 5000;
/** Without a word from the PC over the relay for this long, the relay link counts as down. */
const RELAY_SILENCE_MS = 35_000;
const PC_OFFLINE_AFTER_MS = 12_000;

type DirectProblem = null | 'pc-offline' | 'blocked' | 'broker';

export class RemoteClient {
    private readonly phoneId = randomId(8);
    private stopped = false;
    private pending = new Map<string, (r: CommandResult) => void>();
    private authError: string | null = null;
    snapshot: ClientSnapshot;

    // direct link
    private peer: Peer | null = null;
    private conn: DataConnection | null = null;
    private directAuthed = false;
    private directProblem: DirectProblem = null;
    private directTimer: ReturnType<typeof setTimeout> | undefined;
    private directFailures = 0;

    // relay link
    private relay: RelayChannel | null = null;
    private keys: RelayKeys | null = null;
    private relayAuthed = false;
    private relayHeard = 0;
    private relayHelloSince = 0;
    private relayTicker: ReturnType<typeof setInterval> | undefined;

    constructor(
        private pairing: Pairing,
        private device: string,
        private onChange: (s: ClientSnapshot) => void,
    ) {
        this.snapshot = { status: 'connecting', via: null, pcName: pairing.name, state: null, error: null };
    }

    start() {
        this.stopped = false;
        this.startDirect();
        void this.startRelay();
    }

    stop() {
        this.send({ v: PROTOCOL_VERSION, type: 'bye' });
        this.stopped = true;
        clearTimeout(this.directTimer);
        clearInterval(this.relayTicker);
        this.teardownDirect();
        this.relay?.stop();
        this.relay = null;
        this.relayAuthed = false;
        for (const resolve of this.pending.values()) resolve({ ok: false, error: 'Verbindung getrennt' });
        this.pending.clear();
    }

    /** Reconnect right away, e.g. when the app comes back to the foreground. */
    wake() {
        if (this.stopped || this.authError) return;
        if (!this.directAuthed) {
            this.directFailures = 0;
            this.startDirect();
        }
        if (this.relay && this.relay.state !== 'online') {
            this.relay.stop();
            this.relay.start();
        }
    }

    request(cmd: Command): Promise<CommandResult> {
        if (this.snapshot.status !== 'connected') return Promise.resolve({ ok: false, error: 'Nicht verbunden' });
        const id = randomId(6);
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.send({ v: PROTOCOL_VERSION, type: 'request', id, cmd });
            setTimeout(() => {
                if (this.pending.delete(id)) resolve({ ok: false, error: 'Keine Antwort vom PC' });
            }, REQUEST_TIMEOUT_MS);
        });
    }

    /** Sends over the best available link. */
    private send(msg: PhoneMsg) {
        if (this.directAuthed && this.conn?.open) void this.conn.send(msg);
        else if (this.relayAuthed || msg.type === 'bye') this.sendRelay(msg);
    }

    private sendRelay(msg: PhoneMsg) {
        if (this.relay && this.keys) void this.relay.publish(pcTopic(this.keys), { from: this.phoneId, msg });
    }

    private hello(): PhoneMsg {
        return { v: PROTOCOL_VERSION, type: 'hello', key: this.pairing.key, device: this.device, phoneId: this.phoneId };
    }

    // ---- direct -----------------------------------------------------------------

    private startDirect() {
        clearTimeout(this.directTimer);
        this.teardownDirect();
        const peer = new Peer(`nfr-phone-${randomId(8)}`, { ...brokerOptions(this.pairing.broker), debug: 1 });
        this.peer = peer;
        peer.on('open', () => this.connectDirect(peer));
        peer.on('error', (err) => {
            if (this.stopped || this.peer !== peer) return;
            // WebRTC problems of the data connection are handled by the connection itself.
            if (err.type === 'webrtc') return;
            this.directProblem = err.type === 'peer-unavailable' ? 'pc-offline' : 'broker';
            this.update();
            this.retryDirect();
        });
    }

    private connectDirect(peer: Peer) {
        const conn = peer.connect(this.pairing.peerId, { serialization: 'json', reliable: true });
        this.conn = conn;
        // The PC answered through the broker, but no direct path was found:
        // typically Wi-Fi client isolation in hotels or guest networks.
        let blocked = false;
        conn.on('open', () => void conn.send(this.hello()));
        conn.on('data', (data) => this.handle(data as PcMsg, 'direct'));
        conn.on('error', (err) => {
            if (err.type === 'negotiation-failed') blocked = true;
        });
        conn.on('close', () => {
            if (this.stopped || this.conn !== conn) return;
            this.directAuthed = false;
            this.directProblem = blocked ? 'blocked' : 'pc-offline';
            this.update();
            this.retryDirect(blocked);
        });
    }

    private retryDirect(blocked = false) {
        if (this.stopped || this.authError) return;
        clearTimeout(this.directTimer);
        // A blocking network won't change soon; the relay carries on meanwhile.
        const delay = blocked ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(this.directFailures++, 5));
        this.directTimer = setTimeout(() => this.startDirect(), delay);
    }

    private teardownDirect() {
        this.directAuthed = false;
        this.conn = null;
        this.peer?.destroy();
        this.peer = null;
    }

    // ---- relay ---------------------------------------------------------------------

    private async startRelay() {
        const keys = await relayKeys(this.pairing.peerId, this.pairing.key);
        if (this.stopped) return;
        this.keys = keys;
        this.relay = new RelayChannel(
            this.pairing.relay || DEFAULT_RELAY,
            keys,
            phoneTopic(keys, this.phoneId),
            (env) => {
                this.relayHeard = Date.now();
                this.handle(env.msg as PcMsg, 'relay');
            },
            (state) => {
                if (state === 'online') this.relayTick();
                else this.relayAuthed = false;
                this.update();
            },
        );
        this.relay.start();
        this.relayTicker = setInterval(() => this.relayTick(), RELAY_TICK_MS);
    }

    /** Relay has no connection state: say hello until welcomed, then keep pinging. */
    private relayTick() {
        if (this.stopped || this.authError || this.relay?.state !== 'online') return;
        const now = Date.now();
        if (this.relayAuthed && now - this.relayHeard > RELAY_SILENCE_MS) {
            this.relayAuthed = false;
            this.update();
        }
        if (this.relayAuthed) {
            this.sendRelay({ v: PROTOCOL_VERSION, type: 'ping' });
        } else {
            this.relayHelloSince ||= now;
            this.sendRelay(this.hello());
            if (now - this.relayHelloSince > PC_OFFLINE_AFTER_MS) this.update();
        }
    }

    // ---- shared -----------------------------------------------------------------------

    private handle(msg: PcMsg, via: Via) {
        switch (msg?.type) {
            case 'welcome':
                if (via === 'direct') {
                    this.directAuthed = true;
                    this.directFailures = 0;
                    this.directProblem = null;
                } else {
                    this.relayAuthed = true;
                    this.relayHelloSince = 0;
                }
                this.snapshot.pcName = msg.pcName;
                this.update();
                break;
            case 'state':
                // While the direct link works, the PC stops sending state over the relay anyway.
                if (via === 'relay' && this.directAuthed) return;
                this.set({ state: msg.state });
                break;
            case 'response':
                this.pending.get(msg.re)?.({ ok: msg.ok, error: msg.error, data: msg.data });
                this.pending.delete(msg.re);
                break;
            case 'error':
                if (msg.code === 'auth' || msg.code === 'version') {
                    this.authError = msg.message;
                    this.stop();
                    this.update();
                } else {
                    this.set({ error: msg.message });
                }
                break;
        }
    }

    private update() {
        const relayOnline = this.relay?.state === 'online';
        let status: ConnStatus;
        let via: Via | null = null;
        if (this.authError) status = 'auth-failed';
        else if (this.directAuthed) [status, via] = ['connected', 'direct'];
        else if (this.relayAuthed) [status, via] = ['connected', 'relay'];
        else if (this.directProblem === 'blocked') status = 'blocked';
        else if (
            this.directProblem === 'pc-offline' ||
            (relayOnline && this.relayHelloSince && Date.now() - this.relayHelloSince > PC_OFFLINE_AFTER_MS)
        )
            status = 'pc-offline';
        else if (this.directProblem === 'broker' && this.relay?.state === 'offline') status = 'offline';
        else status = 'connecting';
        this.set({ status, via, error: this.authError });
    }

    private set(patch: Partial<ClientSnapshot>) {
        this.snapshot = { ...this.snapshot, ...patch };
        this.onChange(this.snapshot);
    }
}

export function deviceName(): string {
    const model = navigator.userAgent.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/)?.[1]?.trim();
    return model && model !== 'K' ? model : 'Handy';
}
