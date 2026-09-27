import { describe, expect, it } from 'vitest';
import { Opener, chunk, parseChunk, pcTopic, phoneTopic, relayKeys, seal } from '../../shared/relay';

const PEER = 'nfr-0123456789abcdef01234567';
const KEY = '0123456789abcdef0123456789abcdef';

describe('relay encryption', () => {
    it('round-trips an envelope', async () => {
        const k = await relayKeys(PEER, KEY);
        const sealed = await seal(k, { from: 'phone1', ts: Date.now(), msg: { type: 'ping' } });
        expect(sealed).not.toContain('ping');
        expect(await new Opener(k).open(sealed)).toMatchObject({ from: 'phone1', msg: { type: 'ping' } });
    });

    it('derives topics that reveal neither peer id nor key', async () => {
        const k = await relayKeys(PEER, KEY);
        expect(pcTopic(k)).toMatch(/^nfr\/[0-9a-f]{32}\/pc$/);
        expect(phoneTopic(k, 'p1')).toMatch(/^nfr\/[0-9a-f]{32}\/ph\/p1$/);
        expect(pcTopic(k)).not.toContain(PEER.slice(4));
        expect(pcTopic(await relayKeys(PEER, 'f'.repeat(32)))).not.toBe(pcTopic(k));
    });

    it('rejects messages sealed with another key', async () => {
        const k = await relayKeys(PEER, KEY);
        const other = await relayKeys(PEER, 'f'.repeat(32));
        const sealed = await seal(other, { ts: Date.now(), msg: { type: 'request' } });
        expect(await new Opener(k).open(sealed)).toBeNull();
    });

    it('rejects tampered, replayed, stale and garbage messages', async () => {
        const k = await relayKeys(PEER, KEY);
        const opener = new Opener(k);
        const sealed = await seal(k, { ts: Date.now(), msg: 1 });
        const bytes = atob(sealed);
        const flipped = btoa(bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 1));
        expect(await opener.open(flipped)).toBeNull();
        expect(await opener.open(sealed)).not.toBeNull();
        expect(await opener.open(sealed)).toBeNull(); // replay
        const old = await seal(k, { ts: Date.now() - 10 * 60 * 1000, msg: 1 });
        expect(await opener.open(old)).toBeNull();
        expect(await opener.open('not base64 at all!')).toBeNull();
    });
});

describe('relay chunking', () => {
    it('keeps small messages whole and splits large ones into ordered parts', () => {
        expect(chunk('abc', 10)).toEqual(['abc']);
        const big = 'x'.repeat(25) + 'y'.repeat(10);
        const parts = chunk(big, 10);
        expect(parts).toHaveLength(4);
        const parsed = parts.map((p) => parseChunk(p)!);
        expect(parsed.map((p) => `${p.index}/${p.total}`)).toEqual(['0/4', '1/4', '2/4', '3/4']);
        expect(new Set(parsed.map((p) => p.id)).size).toBe(1);
        expect(parsed.map((p) => p.data).join('')).toBe(big);
    });

    it('does not mistake sealed messages or garbage for chunks', async () => {
        const k = await relayKeys(PEER, KEY);
        expect(parseChunk(await seal(k, { ts: Date.now(), msg: 1 }))).toBeNull();
        expect(parseChunk('c1|x|5|2|data')).toBeNull();
        expect(parseChunk('c1|x|a|2|data')).toBeNull();
    });
});
