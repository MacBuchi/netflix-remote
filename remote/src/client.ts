// Connection from the phone to one paired PC over a PeerJS data channel,
// with automatic reconnects (phone screen off, Wi-Fi switch, PC restart …).

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

export type ConnStatus = 'connecting' | 'connected' | 'pc-offline' | 'broker-offline' | 'auth-failed';

export interface ClientSnapshot {
    status: ConnStatus;
    pcName: string;
    state: RemoteState | null;
    error: string | null;
}

const REQUEST_TIMEOUT_MS = 5000;

export class RemoteClient {
    private peer: Peer | null = null;
    private conn: DataConnection | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private failures = 0;
    private stopped = false;
    private pending = new Map<string, (r: CommandResult) => void>();
    snapshot: ClientSnapshot;

    constructor(
        private pairing: Pairing,
        private device: string,
        private onChange: (s: ClientSnapshot) => void,
    ) {
        this.snapshot = { status: 'connecting', pcName: pairing.name, state: null, error: null };
    }

    private set(patch: Partial<ClientSnapshot>) {
        this.snapshot = { ...this.snapshot, ...patch };
        this.onChange(this.snapshot);
    }

    start() {
        this.stopped = false;
        clearTimeout(this.retryTimer);
        this.teardown();
        this.set({ status: 'connecting', error: null });

        const peer = new Peer(`nfr-phone-${randomId(8)}`, { ...brokerOptions(this.pairing.broker), debug: 1 });
        this.peer = peer;
        peer.on('open', () => this.connectToPc());
        peer.on('error', (err) => {
            if (this.stopped) return;
            this.set({ status: err.type === 'peer-unavailable' ? 'pc-offline' : 'broker-offline', error: err.type });
            this.scheduleRetry();
        });
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        this.teardown();
    }

    /** Reconnect right away, e.g. when the app comes back to the foreground. */
    wake() {
        if (!this.stopped && this.snapshot.status !== 'connected' && this.snapshot.status !== 'auth-failed') {
            this.failures = 0;
            this.start();
        }
    }

    request(cmd: Command): Promise<CommandResult> {
        const conn = this.conn;
        if (!conn?.open || this.snapshot.status !== 'connected') {
            return Promise.resolve({ ok: false, error: 'Nicht verbunden' });
        }
        const id = randomId(6);
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.send({ v: PROTOCOL_VERSION, type: 'request', id, cmd });
            setTimeout(() => {
                if (this.pending.delete(id)) resolve({ ok: false, error: 'Keine Antwort vom PC' });
            }, REQUEST_TIMEOUT_MS);
        });
    }

    private send(msg: PhoneMsg) {
        if (this.conn?.open) void this.conn.send(msg);
    }

    private connectToPc() {
        const conn = this.peer!.connect(this.pairing.peerId, { serialization: 'json', reliable: true });
        this.conn = conn;
        conn.on('open', () => this.send({ v: PROTOCOL_VERSION, type: 'hello', key: this.pairing.key, device: this.device }));
        conn.on('data', (data) => this.handle(data as PcMsg));
        conn.on('close', () => {
            if (this.stopped || this.conn !== conn) return;
            if (this.snapshot.status !== 'auth-failed') this.set({ status: 'pc-offline' });
            this.scheduleRetry();
        });
    }

    private handle(msg: PcMsg) {
        switch (msg?.type) {
            case 'welcome':
                this.failures = 0;
                this.set({ status: 'connected', pcName: msg.pcName, error: null });
                break;
            case 'state':
                this.set({ state: msg.state });
                break;
            case 'response':
                this.pending.get(msg.re)?.({ ok: msg.ok, error: msg.error });
                this.pending.delete(msg.re);
                break;
            case 'error':
                if (msg.code === 'auth' || msg.code === 'version') {
                    this.set({ status: 'auth-failed', error: msg.message });
                    this.stop();
                } else {
                    this.set({ error: msg.message });
                }
                break;
        }
    }

    private scheduleRetry() {
        if (this.stopped) return;
        clearTimeout(this.retryTimer);
        const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.failures++, 4));
        this.retryTimer = setTimeout(() => this.start(), delay);
    }

    private teardown() {
        for (const resolve of this.pending.values()) resolve({ ok: false, error: 'Verbindung getrennt' });
        this.pending.clear();
        this.conn = null;
        this.peer?.destroy();
        this.peer = null;
    }
}

export function deviceName(): string {
    const model = navigator.userAgent.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/)?.[1]?.trim();
    return model && model !== 'K' ? model : 'Handy';
}
