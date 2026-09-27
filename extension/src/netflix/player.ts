// Controls the Netflix player from the page's own JavaScript world (MAIN).
//
// Primary path: Netflix's internal player API
//   netflix.appContext.state.playerApp.getAPI().videoPlayer
// It is undocumented, so every call is guarded and falls back to the <video>
// element or to clicking the on-screen buttons. Never set video.currentTime
// directly: Netflix's player crashes on that, seeking must use player.seek().

import type { CommandResult, PlayerCommand, PlayerState, Track } from '../../../shared/protocol';
import { SEL } from './selectors';

interface NfTrack {
    trackId?: string;
    displayName?: string;
    isNoneTrack?: boolean;
}

/** The subset of the Netflix session player we use; everything optional because it's undocumented. */
export interface NfPlayer {
    play?(): void;
    pause?(): void;
    seek?(ms: number): void;
    isPaused?(): boolean;
    getCurrentTime?(): number;
    getDuration?(): number;
    getVolume?(): number;
    setVolume?(v: number): void;
    isMuted?(): boolean;
    setMuted?(m: boolean): void;
    getMovieId?(): number | string;
    getAudioTrackList?(): NfTrack[];
    getAudioTrack?(): NfTrack | undefined;
    setAudioTrack?(t: NfTrack): void;
    getTimedTextTrackList?(): NfTrack[];
    getTimedTextTrack?(): NfTrack | undefined;
    setTimedTextTrack?(t: NfTrack): void;
    getPlaybackRate?(): number;
    setPlaybackRate?(rate: number): void;
}

type Win = Window & { netflix?: any };

export function getNetflixPlayer(win: Win): NfPlayer | null {
    try {
        const vp = win.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        if (!vp) return null;
        const ids: string[] = vp.getAllPlayerSessionIds?.() ?? [];
        // Billboard previews on the browse page also create sessions ("motion-billboard-…").
        const id = ids.find((s) => s.startsWith('watch')) ?? (ids.length === 1 ? ids[0] : undefined);
        return id ? (vp.getVideoPlayerBySessionId(id) ?? null) : null;
    } catch {
        return null;
    }
}

function first(doc: Document, selectors: readonly string[]): HTMLElement | null {
    for (const s of selectors) {
        const el = doc.querySelector<HTMLElement>(s);
        if (el) return el;
    }
    return null;
}

function call<T>(fn: (() => T) | undefined, fallback: T): T {
    if (!fn) return fallback;
    try {
        const v = fn();
        return v === undefined ? fallback : v;
    } catch {
        return fallback;
    }
}

function mapTracks(list: NfTrack[] | undefined): Track[] {
    return (list ?? [])
        .filter((t) => t && t.trackId)
        .map((t) => ({ id: String(t.trackId), label: t.displayName || (t.isNoneTrack ? 'Aus' : String(t.trackId)) }));
}

export class PlayerAdapter {
    private lastTitle = { id: '', title: '', subtitle: '' };
    /** Speed chosen from the phone; re-applied when Netflix resets the video (e.g. after buffering). */
    private rate: number | null = null;

    constructor(private win: Win) {}

    private get doc() {
        return this.win.document;
    }

    private video(): HTMLVideoElement | null {
        return this.doc.querySelector<HTMLVideoElement>(SEL.video);
    }

    private movieId(): string {
        return this.win.location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? '';
    }

    /** Title from the player overlay (only rendered while controls are visible), else Netflix's data cache. */
    private readTitle(p: NfPlayer | null): { title: string; subtitle: string } {
        const id = this.movieId();
        const el = this.doc.querySelector(SEL.videoTitle);
        if (el) {
            const heading = el.querySelector('h4')?.textContent?.trim() ?? '';
            const spans = Array.from(el.querySelectorAll('span'), (s) => s.textContent?.trim() ?? '').filter(Boolean);
            const title = heading || spans.shift() || el.textContent?.trim() || '';
            if (title) this.lastTitle = { id, title, subtitle: spans.join(' · ') };
        }
        if (this.lastTitle.id === id && this.lastTitle.title) return this.lastTitle;
        try {
            const vid = String(call(p?.getMovieId?.bind(p), '') || id);
            const title = this.win.netflix?.falcorCache?.videos?.[vid]?.title?.value;
            if (typeof title === 'string' && title) return { title, subtitle: '' };
        } catch {
            /* cache layout unknown */
        }
        return { title: '', subtitle: '' };
    }

    getState(): PlayerState | null {
        const p = getNetflixPlayer(this.win);
        const v = this.video();
        if (!p && !v) return null;
        const { title, subtitle } = this.readTitle(p);
        const skip = first(this.doc, SEL.skip);
        if (this.rate !== null && v && Math.abs(v.playbackRate - this.rate) > 0.01) v.playbackRate = this.rate;
        return {
            title,
            subtitle,
            positionMs: call(p?.getCurrentTime?.bind(p), v ? v.currentTime * 1000 : 0),
            durationMs: call(p?.getDuration?.bind(p), v && Number.isFinite(v.duration) ? v.duration * 1000 : 0),
            paused: call(p?.isPaused?.bind(p), v ? v.paused : true),
            volume: call(p?.getVolume?.bind(p), v ? v.volume : 1),
            muted: call(p?.isMuted?.bind(p), v ? v.muted : false),
            skipLabel: skip ? skip.textContent?.trim() || 'Überspringen' : null,
            canNext: first(this.doc, SEL.next) !== null,
            audioTracks: mapTracks(call(p?.getAudioTrackList?.bind(p), [])),
            audioTrackId: call(() => p?.getAudioTrack?.()?.trackId ?? null, null),
            textTracks: mapTracks(call(p?.getTimedTextTrackList?.bind(p), [])),
            textTrackId: call(() => p?.getTimedTextTrack?.()?.trackId ?? null, null),
            playbackRate: v ? v.playbackRate : call(p?.getPlaybackRate?.bind(p), 1),
        };
    }

    run(cmd: PlayerCommand): CommandResult {
        const p = getNetflixPlayer(this.win);
        const v = this.video();
        if (!p && !v && cmd.type !== 'player.exit') return { ok: false, error: 'Kein Video aktiv' };
        try {
            switch (cmd.type) {
                case 'player.play':
                    return this.play(p, v);
                case 'player.pause':
                    return this.pause(p, v);
                case 'player.toggle': {
                    const paused = call(p?.isPaused?.bind(p), v ? v.paused : true);
                    return paused ? this.play(p, v) : this.pause(p, v);
                }
                case 'player.seekBy': {
                    const now = call(p?.getCurrentTime?.bind(p), v ? v.currentTime * 1000 : 0);
                    return this.seek(p, now + cmd.ms);
                }
                case 'player.seekTo':
                    return this.seek(p, cmd.ms);
                case 'player.setVolume':
                    if (p?.setVolume) p.setVolume(cmd.volume);
                    else if (v) v.volume = cmd.volume;
                    if (cmd.volume > 0) this.setMuted(p, v, false);
                    return { ok: true };
                case 'player.setMuted':
                    this.setMuted(p, v, cmd.muted);
                    return { ok: true };
                case 'player.skip':
                    return this.click(SEL.skip, 'Gerade nichts zu überspringen');
                case 'player.nextEpisode':
                    return this.click(SEL.next, 'Keine nächste Folge verfügbar');
                case 'player.setAudioTrack':
                    return this.setTrack(p?.getAudioTrackList?.bind(p), p?.setAudioTrack?.bind(p), cmd.id);
                case 'player.setTextTrack':
                    return this.setTrack(p?.getTimedTextTrackList?.bind(p), p?.setTimedTextTrack?.bind(p), cmd.id);
                case 'player.setRate':
                    return this.setRate(p, v, cmd.rate);
                case 'player.exit': {
                    const back = first(this.doc, SEL.back);
                    if (back) back.click();
                    else this.win.history.back();
                    return { ok: true };
                }
            }
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    private play(p: NfPlayer | null, v: HTMLVideoElement | null): CommandResult {
        if (p?.play) p.play();
        else void v?.play();
        return { ok: true };
    }

    private pause(p: NfPlayer | null, v: HTMLVideoElement | null): CommandResult {
        if (p?.pause) p.pause();
        else v?.pause();
        return { ok: true };
    }

    private seek(p: NfPlayer | null, ms: number): CommandResult {
        if (!p?.seek) return { ok: false, error: 'Spulen nicht möglich (Netflix-Player-API fehlt)' };
        const dur = call(p.getDuration?.bind(p), Infinity);
        p.seek(Math.max(0, Math.min(ms, dur - 1000)));
        return { ok: true };
    }

    private setRate(p: NfPlayer | null, v: HTMLVideoElement | null, rate: number): CommandResult {
        if (!p?.setPlaybackRate && !v) return { ok: false, error: 'Geschwindigkeit lässt sich nicht einstellen' };
        this.rate = rate === 1 ? null : rate;
        call(() => p?.setPlaybackRate?.(rate), undefined);
        if (v && Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
        return { ok: true };
    }

    private setMuted(p: NfPlayer | null, v: HTMLVideoElement | null, muted: boolean) {
        if (p?.setMuted) p.setMuted(muted);
        else if (v) v.muted = muted;
    }

    private click(selectors: readonly string[], error: string): CommandResult {
        const el = first(this.doc, selectors);
        if (!el) return { ok: false, error };
        el.click();
        return { ok: true };
    }

    private setTrack(
        list: (() => NfTrack[]) | undefined,
        set: ((t: NfTrack) => void) | undefined,
        id: string,
    ): CommandResult {
        const track = call(list, []).find((t) => String(t.trackId) === id);
        if (!track || !set) return { ok: false, error: 'Spur nicht gefunden' };
        set(track);
        return { ok: true };
    }
}
