// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerAdapter } from '../../extension/src/netflix/player';
import { detailsUrl, rememberReturn, takeReturn } from '../../extension/src/netflix/return-to';

const url = (path: string) => new URL(path, 'https://www.netflix.com');

beforeEach(() => sessionStorage.clear());

describe('detailsUrl', () => {
    it('opens details over the current list, so closing them returns there', () => {
        expect(detailsUrl(url('/search?q=dark'), '7002')).toBe('/search?q=dark&jbv=7002');
        expect(detailsUrl(url('/browse/genre/83'), '7002')).toBe('/browse/genre/83?jbv=7002');
        expect(detailsUrl(url('/search?q=dark&jbv=1'), '7002')).toBe('/search?q=dark&jbv=7002');
    });

    it('uses the home page from anywhere else', () => {
        expect(detailsUrl(url('/watch/80100172?trackId=1'), '7002')).toBe('/browse?jbv=7002');
    });
});

describe('return to the search after playing', () => {
    it('remembers a search page once, without an open details dialog', () => {
        rememberReturn(url('/search?q=dark&jbv=7002'), sessionStorage);
        expect(takeReturn(sessionStorage)).toBe('/search?q=dark');
        expect(takeReturn(sessionStorage)).toBeNull();
    });

    it('forgets it when playing from another page', () => {
        rememberReturn(url('/search?q=dark'), sessionStorage);
        rememberReturn(url('/browse'), sessionStorage);
        expect(takeReturn(sessionStorage)).toBeNull();
    });

    it('the player back command goes to the remembered search instead of Netflix\'s back button', () => {
        document.body.innerHTML = '<video></video><button data-uia="control-nav-back"></button>';
        const back = vi.fn();
        document.querySelector('button')!.addEventListener('click', back);
        const assign = vi.fn();
        const win = { document, sessionStorage, location: { pathname: '/watch/7002', assign } } as any;
        const player = new PlayerAdapter(win);

        rememberReturn(url('/search?q=dark'), sessionStorage);
        expect(player.run({ type: 'player.exit' })).toEqual({ ok: true });
        expect(assign).toHaveBeenCalledWith('/search?q=dark');
        expect(back).not.toHaveBeenCalled();

        player.run({ type: 'player.exit' });
        expect(back).toHaveBeenCalledTimes(1);
    });
});
