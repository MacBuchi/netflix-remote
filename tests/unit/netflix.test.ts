// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectPageKind } from '../../extension/src/netflix/page-kind';
import { PlayerAdapter, getNetflixPlayer, type NfPlayer } from '../../extension/src/netflix/player';

function fakePlayer(overrides: Partial<NfPlayer> = {}): NfPlayer & { t: number; vol: number; mute: boolean; paused: boolean } {
    const audio = [
        { trackId: 'a-de', displayName: 'Deutsch' },
        { trackId: 'a-en', displayName: 'English' },
    ];
    const text = [
        { trackId: 't-off', displayName: 'Aus', isNoneTrack: true },
        { trackId: 't-de', displayName: 'Deutsch' },
    ];
    const p: any = {
        t: 60_000,
        vol: 0.5,
        mute: false,
        paused: false,
        audio: audio[0],
        text: text[0],
        play: vi.fn(() => void (p.paused = false)),
        pause: vi.fn(() => void (p.paused = true)),
        seek: vi.fn((ms: number) => void (p.t = ms)),
        isPaused: () => p.paused,
        getCurrentTime: () => p.t,
        getDuration: () => 3_600_000,
        getVolume: () => p.vol,
        setVolume: vi.fn((v: number) => void (p.vol = v)),
        isMuted: () => p.mute,
        setMuted: vi.fn((m: boolean) => void (p.mute = m)),
        getAudioTrackList: () => audio,
        getAudioTrack: () => p.audio,
        setAudioTrack: vi.fn((t) => void (p.audio = t)),
        getTimedTextTrackList: () => text,
        getTimedTextTrack: () => p.text,
        setTimedTextTrack: vi.fn((t) => void (p.text = t)),
        ...overrides,
    };
    return p;
}

function installNetflix(player: NfPlayer, sessions = ['motion-billboard-1', 'watch-123']) {
    const byId = vi.fn((id: string) => (id.startsWith('watch') ? player : { preview: true }));
    (window as any).netflix = {
        appContext: {
            state: {
                playerApp: {
                    getAPI: () => ({ videoPlayer: { getAllPlayerSessionIds: () => sessions, getVideoPlayerBySessionId: byId } }),
                },
            },
        },
    };
    return byId;
}

beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as any).netflix;
    history.replaceState(null, '', '/watch/80100172');
});

describe('detectPageKind', () => {
    const at = (path: string) => detectPageKind(new URL(`https://www.netflix.com${path}`), document);
    it('recognizes Netflix pages', () => {
        expect(at('/watch/123?trackId=1')).toBe('watch');
        expect(at('/browse')).toBe('browse');
        expect(at('/browse/genre/83')).toBe('browse');
        expect(at('/browse?jbv=80100172')).toBe('title');
        expect(at('/title/80100172')).toBe('title');
        expect(at('/search?q=dark')).toBe('search');
        expect(at('/de/login')).toBe('login');
        expect(at('/YourAccount')).toBe('other');
    });
    it('detects the profile gate', () => {
        document.body.innerHTML = '<a data-uia="profile-link">Marcus</a>';
        expect(at('/browse')).toBe('profiles');
    });

    it('ignores the profile switcher in the header menu of browse pages', () => {
        document.body.innerHTML = `
            <div class="pinning-header"><div class="account-menu"><ul class="sub-menu">
                <li class="sub-menu-item profile-link"><a data-uia="profile-link" href="/SwitchProfile?tkn=1">Kinder</a></li>
            </ul></div></div>
            <div class="lolomoRow"><a href="/watch/1" aria-label="A"></a><a href="/watch/2" aria-label="B"></a><a href="/watch/3" aria-label="C"></a></div>`;
        expect(at('/browse')).toBe('browse');
    });
});

describe('getNetflixPlayer', () => {
    it('prefers the watch session over billboard previews', () => {
        const player = fakePlayer();
        installNetflix(player);
        expect(getNetflixPlayer(window)).toBe(player);
    });
    it('returns null when Netflix has no player', () => {
        expect(getNetflixPlayer(window)).toBeNull();
        installNetflix(fakePlayer(), ['motion-billboard-1', 'motion-billboard-2']);
        expect(getNetflixPlayer(window)).toBeNull();
    });
});

describe('PlayerAdapter', () => {
    it('reports state from the player API and on-screen buttons', () => {
        const player = fakePlayer();
        installNetflix(player);
        document.body.innerHTML = `
            <div data-uia="video-title"><h4>Dark</h4><span>S1:E3</span><span>Vergangenheit und Gegenwart</span></div>
            <button data-uia="player-skip-intro">Intro überspringen</button>`;
        const state = new PlayerAdapter(window).getState();
        expect(state).toMatchObject({
            title: 'Dark',
            subtitle: 'S1:E3 · Vergangenheit und Gegenwart',
            positionMs: 60_000,
            durationMs: 3_600_000,
            paused: false,
            volume: 0.5,
            skipLabel: 'Intro überspringen',
            canNext: false,
            audioTrackId: 'a-de',
            textTrackId: 't-off',
        });
        expect(state?.audioTracks).toEqual([
            { id: 'a-de', label: 'Deutsch' },
            { id: 'a-en', label: 'English' },
        ]);
    });

    it('remembers the title after the overlay hides', () => {
        installNetflix(fakePlayer());
        const adapter = new PlayerAdapter(window);
        document.body.innerHTML = '<div data-uia="video-title"><h4>Dark</h4></div>';
        adapter.getState();
        document.body.innerHTML = '';
        expect(adapter.getState()?.title).toBe('Dark');
    });

    it('controls playback through the API', () => {
        const player = fakePlayer();
        installNetflix(player);
        const a = new PlayerAdapter(window);
        expect(a.run({ type: 'player.toggle' })).toEqual({ ok: true });
        expect(player.pause).toHaveBeenCalled();
        a.run({ type: 'player.toggle' });
        expect(player.play).toHaveBeenCalled();
        a.run({ type: 'player.seekBy', ms: 10_000 });
        expect(player.seek).toHaveBeenLastCalledWith(70_000);
        a.run({ type: 'player.seekBy', ms: -999_999 });
        expect(player.seek).toHaveBeenLastCalledWith(0);
        a.run({ type: 'player.seekTo', ms: 99_999_999 });
        expect(player.seek).toHaveBeenLastCalledWith(3_599_000);
    });

    it('sets volume and unmutes when raising volume', () => {
        const player = fakePlayer();
        player.mute = true;
        installNetflix(player);
        new PlayerAdapter(window).run({ type: 'player.setVolume', volume: 0.8 });
        expect(player.setVolume).toHaveBeenCalledWith(0.8);
        expect(player.setMuted).toHaveBeenCalledWith(false);
    });

    it('switches audio and subtitle tracks by id', () => {
        const player = fakePlayer();
        installNetflix(player);
        const a = new PlayerAdapter(window);
        expect(a.run({ type: 'player.setAudioTrack', id: 'a-en' })).toEqual({ ok: true });
        expect(player.setAudioTrack).toHaveBeenCalledWith({ trackId: 'a-en', displayName: 'English' });
        expect(a.run({ type: 'player.setTextTrack', id: 'missing' }).ok).toBe(false);
    });

    it('clicks skip and next-episode buttons', () => {
        installNetflix(fakePlayer());
        const skip = vi.fn();
        const next = vi.fn();
        document.body.innerHTML = '<button data-uia="player-skip-recap"></button><button data-uia="next-episode-seamless-button"></button>';
        document.querySelector('[data-uia="player-skip-recap"]')!.addEventListener('click', skip);
        document.querySelector('[data-uia="next-episode-seamless-button"]')!.addEventListener('click', next);
        const a = new PlayerAdapter(window);
        expect(a.run({ type: 'player.skip' })).toEqual({ ok: true });
        expect(a.run({ type: 'player.nextEpisode' })).toEqual({ ok: true });
        expect(skip).toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('reports errors instead of throwing', () => {
        installNetflix(fakePlayer());
        const a = new PlayerAdapter(window);
        expect(a.run({ type: 'player.skip' })).toEqual({ ok: false, error: 'Gerade nichts zu überspringen' });
        delete (window as any).netflix;
        expect(a.run({ type: 'player.play' })).toEqual({ ok: false, error: 'Kein Video aktiv' });
        expect(a.getState()).toBeNull();
    });

    it('falls back to the <video> element without the API', () => {
        document.body.innerHTML = '<video></video>';
        const video = document.querySelector('video')!;
        const a = new PlayerAdapter(window);
        a.run({ type: 'player.setVolume', volume: 0.3 });
        expect(video.volume).toBeCloseTo(0.3);
        a.run({ type: 'player.setMuted', muted: true });
        expect(video.muted).toBe(true);
        expect(a.run({ type: 'player.seekBy', ms: 10_000 }).ok).toBe(false);
        expect(a.getState()).toMatchObject({ volume: 0.3, muted: true });
    });
});
