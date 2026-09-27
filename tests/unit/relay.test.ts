import { describe, expect, it } from 'vitest';
import { Opener, pcTopic, phoneTopic, relayKeys, seal } from '../../shared/relay';

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
