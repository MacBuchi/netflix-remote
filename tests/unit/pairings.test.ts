// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Pairing } from '../../shared/protocol';
import { activePeerId, loadPairings, pairingLabel, savePairing } from '../../remote/src/pairings';
import { describeDevice } from '../../extension/src/device';

const pc = (peerId: string, extra: Partial<Pairing> = {}): Pairing => ({
    peerId: `nfr-${peerId}`,
    key: '0123456789abcdef',
    name: 'Netflix-PC',
    broker: '',
    relay: '',
    ...extra,
});

beforeEach(() => localStorage.clear());

describe('pairings', () => {
    it('cleans up old duplicates of the same name, keeping the newest', () => {
        localStorage.setItem('nfr.pairings', JSON.stringify([pc('c'), pc('b'), pc('a'), pc('x', { name: 'Büro' })]));
        localStorage.setItem('nfr.active', JSON.stringify('nfr-a'));
        expect(loadPairings().map((p) => p.peerId)).toEqual(['nfr-c', 'nfr-x']);
        expect(activePeerId()).toBe('nfr-c');
        expect(JSON.parse(localStorage.getItem('nfr.pairings')!)).toHaveLength(2);
    });

    it('a new pairing replaces older ones of the same PC, but not another browser of the same name', () => {
        savePairing(pc('old'));
        savePairing(pc('opera', { device: 'Opera · macOS' }));
        savePairing(pc('chrome', { device: 'Chrome · macOS' }));
        expect(loadPairings().map((p) => p.peerId)).toEqual(['nfr-chrome', 'nfr-opera']);
        savePairing(pc('chrome2', { device: 'Chrome · macOS' }));
        expect(loadPairings().map((p) => p.peerId)).toEqual(['nfr-chrome2', 'nfr-opera']);
        expect(activePeerId()).toBe('nfr-chrome2');
    });

    it('labels repeated names with browser and system', () => {
        const all = [pc('a', { device: 'Chrome · macOS' }), pc('b', { device: 'Opera · macOS' }), pc('c', { name: 'Büro' })];
        expect(all.map((p) => pairingLabel(p, all))).toEqual(['Netflix-PC (Chrome · macOS)', 'Netflix-PC (Opera · macOS)', 'Büro']);
    });
});

describe('describeDevice', () => {
    const nav = (userAgent: string, brands?: string[], platform?: string) =>
        ({ userAgent, userAgentData: brands && { brands: brands.map((brand) => ({ brand })), platform } }) as unknown as Navigator;

    it('names browser and system', () => {
        expect(describeDevice(nav('x', ['Not/A)Brand', 'Opera', 'Chromium'], 'macOS'))).toBe('Opera · macOS');
        expect(describeDevice(nav('x', ['Chromium', 'Google Chrome'], 'Windows'))).toBe('Chrome · Windows');
        expect(describeDevice(nav('Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36 OPR/120.0'))).toBe('Opera · Linux');
        expect(describeDevice(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36', ['Chromium'], 'macOS'))).toBe(
            'Chrome · macOS',
        );
    });
});
