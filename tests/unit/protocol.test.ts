import { describe, expect, it } from 'vitest';
import {
    brokerOptions,
    buildPairingUrl,
    formatTime,
    parseCommand,
    parsePairingHash,
    parsePhoneMsg,
} from '../../shared/protocol';

describe('parseCommand', () => {
    it('accepts whitelisted commands', () => {
        expect(parseCommand({ type: 'player.toggle' })).toEqual({ type: 'player.toggle' });
        expect(parseCommand({ type: 'player.seekBy', ms: -10000.4 })).toEqual({ type: 'player.seekBy', ms: -10000 });
        expect(parseCommand({ type: 'app.fullscreen', on: true })).toEqual({ type: 'app.fullscreen', on: true });
    });

    it('strips unknown fields', () => {
        expect(parseCommand({ type: 'player.play', evil: 'x' })).toEqual({ type: 'player.play' });
    });

    it('clamps volume', () => {
        expect(parseCommand({ type: 'player.setVolume', volume: 3 })).toEqual({ type: 'player.setVolume', volume: 1 });
        expect(parseCommand({ type: 'player.setVolume', volume: -1 })).toEqual({ type: 'player.setVolume', volume: 0 });
    });

    it('rejects unknown or malformed commands', () => {
        expect(parseCommand({ type: 'eval', code: 'x' })).toBeNull();
        expect(parseCommand({ type: 'player.seekTo', ms: -5 })).toBeNull();
        expect(parseCommand({ type: 'player.seekTo', ms: NaN })).toBeNull();
        expect(parseCommand({ type: 'player.setMuted', muted: 'yes' })).toBeNull();
        expect(parseCommand(null)).toBeNull();
        expect(parseCommand([])).toBeNull();
    });
});

describe('parsePhoneMsg', () => {
    it('parses hello and request, from objects or JSON', () => {
        expect(parsePhoneMsg({ v: 1, type: 'hello', key: 'k', device: 'Pixel' })).toEqual({
            v: 1,
            type: 'hello',
            key: 'k',
            device: 'Pixel',
        });
        expect(parsePhoneMsg('{"v":1,"type":"request","id":"a","cmd":{"type":"player.pause"}}')).toEqual({
            v: 1,
            type: 'request',
            id: 'a',
            cmd: { type: 'player.pause' },
        });
    });

    it('rejects requests with invalid commands and garbage', () => {
        expect(parsePhoneMsg({ v: 1, type: 'request', id: 'a', cmd: { type: 'nope' } })).toBeNull();
        expect(parsePhoneMsg('not json')).toBeNull();
        expect(parsePhoneMsg({ type: 'hello', key: 'k', device: 'x' })).toBeNull();
    });
});

describe('pairing link', () => {
    const pairing = { peerId: 'nfr-0123456789abcdef01234567', key: '0123456789abcdef0123456789abcdef', name: 'Mac im Büro', broker: '' };

    it('round-trips through the QR url and keeps the secret in the hash', () => {
        const url = buildPairingUrl('https://example.github.io/netflix-remote/', pairing);
        const parsed = new URL(url);
        expect(parsed.search).toBe('');
        expect(parsePairingHash(parsed.hash)).toEqual(pairing);
    });

    it('carries a custom broker', () => {
        const url = buildPairingUrl('https://x/', { ...pairing, broker: 'wss://peer.example.com:9000/app' });
        expect(parsePairingHash(new URL(url).hash)?.broker).toBe('wss://peer.example.com:9000/app');
    });

    it('rejects incomplete or malformed links', () => {
        expect(parsePairingHash('#pc=nfr-0123456789')).toBeNull();
        expect(parsePairingHash('#pc=bad id!&k=0123456789abcdef0123')).toBeNull();
        expect(parsePairingHash('')).toBeNull();
    });
});

describe('brokerOptions', () => {
    it('defaults to the PeerJS cloud', () => {
        expect(brokerOptions('')).toEqual({});
    });
    it('parses self-hosted brokers', () => {
        expect(brokerOptions('ws://192.168.1.5:9000/')).toEqual({ host: '192.168.1.5', port: 9000, path: '/', secure: false });
        expect(brokerOptions('wss://peer.example.com/x')).toEqual({ host: 'peer.example.com', port: 443, path: '/x', secure: true });
    });
});

describe('formatTime', () => {
    it('formats minutes and hours', () => {
        expect(formatTime(0)).toBe('0:00');
        expect(formatTime(65_000)).toBe('1:05');
        expect(formatTime(3_725_000)).toBe('1:02:05');
        expect(formatTime(-5)).toBe('0:00');
    });
});
