// Fallback transport for networks that block direct WebRTC between devices
// (client isolation in hotel or guest Wi-Fi): messages go through a public
// MQTT broker over WSS instead.
//
// The broker is untrusted. Every message is end-to-end encrypted and
// authenticated with AES-GCM using a key derived from the pairing secret, and
// topic names are derived from it too, so the broker sees neither content nor
// who talks to whom. Old or replayed messages are dropped.

import mqtt, { type MqttClient } from 'mqtt';

export const DEFAULT_RELAY = 'wss://broker.hivemq.com:8884/mqtt';

/** Messages older than this (or from a clock this far ahead) are dropped. */
const MAX_AGE_MS = 2 * 60 * 1000;

export interface RelayKeys {
    base: string;
    key: CryptoKey;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(text: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function relayKeys(peerId: string, pairKey: string): Promise<RelayKeys> {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(`nfr-relay-key|${peerId}|${pairKey}`));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const topic = (await sha256Hex(`nfr-relay-topic|${peerId}|${pairKey}`)).slice(0, 32);
    return { base: `nfr/${topic}`, key };
}

export const pcTopic = (k: RelayKeys) => `${k.base}/pc`;
export const phoneTopic = (k: RelayKeys, phoneId: string) => `${k.base}/ph/${phoneId}`;

export interface Envelope {
    /** Sender's phone id (phone → PC only). */
    from?: string;
    ts: number;
    msg: unknown;
}

function toBase64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

function fromBase64(text: string): Uint8Array {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export async function seal(k: RelayKeys, env: Envelope): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.key, enc.encode(JSON.stringify(env))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return toBase64(out);
}

/** Decrypts and checks freshness; returns null for anything forged, garbled, stale or replayed. */
export class Opener {
    private seen = new Map<string, number>();

    constructor(private k: RelayKeys) {}

    async open(payload: string, now = Date.now()): Promise<Envelope | null> {
        try {
            const bytes = fromBase64(payload);
            const iv = bytes.slice(0, 12);
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.k.key, bytes.slice(12));
            const env = JSON.parse(dec.decode(plain)) as Envelope;
            if (typeof env?.ts !== 'number' || Math.abs(now - env.ts) > MAX_AGE_MS) return null;
            const nonce = payload.slice(0, 16);
            if (this.seen.has(nonce)) return null;
            this.seen.set(nonce, now);
            for (const [n, t] of this.seen) if (now - t > MAX_AGE_MS) this.seen.delete(n);
            return env;
        } catch {
            return null;
        }
    }
}

export type RelayState = 'connecting' | 'online' | 'offline';

/** One MQTT connection: listens on `listen`, publishes sealed envelopes to any topic. Reconnects on its own. */
export class RelayChannel {
    private client: MqttClient | null = null;
    private opener: Opener;
    state: RelayState = 'connecting';

    constructor(
        private url: string,
        private keys: RelayKeys,
        private listen: string,
        private onEnvelope: (env: Envelope) => void,
        private onState: (s: RelayState) => void = () => {},
    ) {
        this.opener = new Opener(keys);
    }

    start() {
        const client = mqtt.connect(this.url, {
            clientId: `nfr_${crypto.getRandomValues(new Uint32Array(2)).join('')}`,
            clean: true,
            keepalive: 30,
            reconnectPeriod: 3000,
            connectTimeout: 10_000,
        });
        this.client = client;
        client.on('connect', () => {
            client.subscribe(this.listen, { qos: 0 });
            this.setState('online');
        });
        client.on('offline', () => this.setState('offline'));
        client.on('error', () => this.setState('offline'));
        client.on('message', async (_topic, payload) => {
            const env = await this.opener.open(payload.toString());
            if (env) this.onEnvelope(env);
        });
    }

    private setState(s: RelayState) {
        if (this.state === s) return;
        this.state = s;
        this.onState(s);
    }

    async publish(topic: string, env: Omit<Envelope, 'ts'>) {
        if (!this.client?.connected) return;
        this.client.publish(topic, await seal(this.keys, { ...env, ts: Date.now() }), { qos: 0 });
    }

    stop() {
        this.client?.end(true);
        this.client = null;
    }
}
