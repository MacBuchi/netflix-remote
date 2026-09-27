import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatTime, type Command, type Pairing, type PageKind, type PlayerState, type RemoteState } from '../../shared/protocol';
import { RemoteClient, deviceName, type ClientSnapshot } from './client';
import { Icon, type IconName } from './icons';
import { activePeerId, consumePairingFromUrl, loadPairings, removePairing, setActive } from './pairings';
import './style.css';

type Send = (cmd: Command) => void;

const PAGE_NAMES: Record<PageKind, string> = {
    none: 'Netflix ist nicht geöffnet',
    profiles: 'Profilauswahl',
    browse: 'Übersicht',
    title: 'Titel-Details',
    search: 'Suche',
    watch: 'Wiedergabe',
    login: 'Anmeldung',
    other: 'Netflix',
};

function haptic() {
    navigator.vibrate?.(10);
}

function useWakeLock(active: boolean) {
    useEffect(() => {
        if (!active || !('wakeLock' in navigator)) return;
        let lock: WakeLockSentinel | null = null;
        const acquire = () => {
            if (document.visibilityState === 'visible') {
                navigator.wakeLock.request('screen').then((l) => (lock = l), () => {});
            }
        };
        acquire();
        document.addEventListener('visibilitychange', acquire);
        return () => {
            document.removeEventListener('visibilitychange', acquire);
            void lock?.release();
        };
    }, [active]);
}

function App() {
    const [pairings, setPairings] = useState<Pairing[]>(() => {
        consumePairingFromUrl();
        return loadPairings();
    });
    const [activeId, setActiveId] = useState(() => activePeerId() ?? pairings[0]?.peerId ?? null);
    const pairing = pairings.find((p) => p.peerId === activeId) ?? pairings[0];
    const [snap, setSnap] = useState<ClientSnapshot | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const client = useRef<RemoteClient | null>(null);

    useEffect(() => {
        if (!pairing) return;
        const c = new RemoteClient(pairing, deviceName(), setSnap);
        client.current = c;
        setSnap(c.snapshot);
        c.start();
        const onVisible = () => document.visibilityState === 'visible' && c.wake();
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', onVisible);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('online', onVisible);
            c.stop();
        };
    }, [pairing?.peerId, pairing?.key]);

    // Scanning a QR code while the app is already open only changes the hash.
    useEffect(() => {
        const onHash = () => {
            const p = consumePairingFromUrl();
            if (!p) return;
            setPairings(loadPairings());
            setActiveId(p.peerId);
        };
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);

    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 2500);
        return () => clearTimeout(t);
    }, [toast]);

    useWakeLock(snap?.status === 'connected');

    const send: Send = useMemo(
        () => (cmd) => {
            haptic();
            void client.current?.request(cmd).then((r) => !r.ok && setToast(r.error ?? 'Fehler'));
        },
        [],
    );

    if (!pairing) return <Onboarding />;

    const switchPc = (peerId: string) => {
        setActive(peerId);
        setActiveId(peerId);
    };
    const forget = () => {
        const list = removePairing(pairing.peerId);
        setPairings(list);
        setActiveId(list[0]?.peerId ?? null);
    };

    return (
        <div class="app">
            <Header pairings={pairings} active={pairing} snap={snap} onSwitch={switchPc} />
            <main>
                {snap?.status === 'connected' ? (
                    <Connected state={snap.state} send={send} />
                ) : (
                    <Disconnected snap={snap} onRetry={() => client.current?.wake() ?? undefined} onForget={forget} />
                )}
            </main>
            {toast && <div class="toast">{toast}</div>}
        </div>
    );
}

function Header({ pairings, active, snap, onSwitch }: {
    pairings: Pairing[];
    active: Pairing;
    snap: ClientSnapshot | null;
    onSwitch: (id: string) => void;
}) {
    const status = snap?.status ?? 'connecting';
    return (
        <header>
            <span class={`dot ${status}`} />
            {pairings.length > 1 ? (
                <select value={active.peerId} onChange={(e) => onSwitch((e.target as HTMLSelectElement).value)}>
                    {pairings.map((p) => (
                        <option value={p.peerId}>{p.peerId === active.peerId ? (snap?.pcName ?? p.name) : p.name}</option>
                    ))}
                </select>
            ) : (
                <span class="pc-name">{snap?.pcName ?? active.name}</span>
            )}
        </header>
    );
}

function Onboarding() {
    return (
        <div class="app">
            <main class="center">
                <h1>Couch Remote</h1>
                <ol class="steps">
                    <li>Extension „Couch Remote für Netflix“ in Chrome auf dem PC/Mac installieren.</li>
                    <li>In Chrome auf das Extension-Symbol klicken – ein QR-Code erscheint.</li>
                    <li>QR-Code mit der Handy-Kamera scannen. Fertig – ab dann verbindet sich diese App automatisch.</li>
                </ol>
                <p class="muted">Tipp: Im Browser-Menü „Zum Startbildschirm hinzufügen“ wählen, dann startet die Fernbedienung wie eine App.</p>
            </main>
        </div>
    );
}

const STATUS_TEXT: Record<ClientSnapshot['status'], string> = {
    connecting: 'Verbinde …',
    connected: 'Verbunden',
    'pc-offline': 'PC nicht erreichbar. Läuft Chrome auf dem PC?',
    'broker-offline': 'Keine Verbindung zum Vermittlungs-Server. Internet am Handy prüfen.',
    'auth-failed': 'Kopplung ungültig.',
};

function Disconnected({ snap, onRetry, onForget }: { snap: ClientSnapshot | null; onRetry: () => void; onForget: () => void }) {
    const status = snap?.status ?? 'connecting';
    return (
        <div class="center">
            {status === 'connecting' && <div class="spinner" />}
            <p>{STATUS_TEXT[status]}</p>
            {snap?.error && status === 'auth-failed' && <p class="muted">{snap.error}</p>}
            {status === 'auth-failed' ? (
                <button class="btn" onClick={onForget}>Kopplung entfernen</button>
            ) : (
                status !== 'connecting' && <button class="btn" onClick={onRetry}>Erneut versuchen</button>
            )}
        </div>
    );
}

function Connected({ state, send }: { state: RemoteState | null; send: Send }) {
    if (!state) return <div class="center"><div class="spinner" /></div>;
    if (state.page === 'none') {
        return (
            <div class="center">
                <p>{PAGE_NAMES.none}.</p>
                <button class="btn primary" onClick={() => send({ type: 'app.openNetflix' })}>Netflix am PC öffnen</button>
            </div>
        );
    }
    if (state.page === 'watch' && state.player) return <PlayerView p={state.player} fullscreen={state.fullscreen} send={send} />;
    return (
        <div class="center">
            <p class="muted">Am PC geöffnet</p>
            <h2>{PAGE_NAMES[state.page]}</h2>
            <p class="muted">Titel auswählen und starten – die Katalogansicht auf dem Handy kommt im nächsten Schritt.</p>
            <div class="row">
                <IconButton icon="home" label="Übersicht" onClick={() => send({ type: 'app.browse' })} />
                <IconButton icon="tv" label="In den Vordergrund" onClick={() => send({ type: 'app.openNetflix' })} />
            </div>
        </div>
    );
}

function IconButton({ icon, label, onClick, big, disabled }: {
    icon: IconName;
    label: string;
    onClick: () => void;
    big?: boolean;
    disabled?: boolean;
}) {
    return (
        <button class={`icon-btn${big ? ' big' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
            <Icon name={icon} size={big ? 44 : 28} />
        </button>
    );
}

function PlayerView({ p, fullscreen, send }: { p: PlayerState; fullscreen: boolean; send: Send }) {
    const [dragMs, setDragMs] = useState<number | null>(null);
    const pos = dragMs ?? p.positionMs;
    const volume = Math.round((p.muted ? 0 : p.volume) * 100);
    const setVolume = (v: number) => send({ type: 'player.setVolume', volume: Math.min(1, Math.max(0, v)) });

    return (
        <div class="player">
            <div class="title">
                <h2>{p.title || 'Netflix'}</h2>
                {p.subtitle && <p class="muted">{p.subtitle}</p>}
            </div>

            <div class="seek">
                <input
                    type="range"
                    min={0}
                    max={Math.max(1, p.durationMs)}
                    step={1000}
                    value={pos}
                    aria-label="Position"
                    onInput={(e) => setDragMs(Number((e.target as HTMLInputElement).value))}
                    onChange={(e) => {
                        send({ type: 'player.seekTo', ms: Number((e.target as HTMLInputElement).value) });
                        setTimeout(() => setDragMs(null), 800);
                    }}
                />
                <div class="times">
                    <span>{formatTime(pos)}</span>
                    <span>-{formatTime(p.durationMs - pos)}</span>
                </div>
            </div>

            <div class="row transport">
                <IconButton icon="replay10" label="10 Sekunden zurück" onClick={() => send({ type: 'player.seekBy', ms: -10_000 })} />
                <IconButton
                    big
                    icon={p.paused ? 'play' : 'pause'}
                    label={p.paused ? 'Abspielen' : 'Pause'}
                    onClick={() => send({ type: p.paused ? 'player.play' : 'player.pause' })}
                />
                <IconButton icon="forward10" label="10 Sekunden vor" onClick={() => send({ type: 'player.seekBy', ms: 10_000 })} />
            </div>

            <div class="row">
                {p.skipLabel && (
                    <button class="btn primary" onClick={() => send({ type: 'player.skip' })}>{p.skipLabel}</button>
                )}
                {p.canNext && (
                    <button class="btn" onClick={() => send({ type: 'player.nextEpisode' })}>
                        <Icon name="next" size={20} /> Nächste Folge
                    </button>
                )}
            </div>

            <div class="volume">
                <IconButton
                    icon={p.muted || volume === 0 ? 'volOff' : 'volDown'}
                    label={p.muted ? 'Ton an' : 'Stumm'}
                    onClick={() => send({ type: 'player.setMuted', muted: !p.muted })}
                />
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volume}
                    aria-label="Lautstärke"
                    onChange={(e) => setVolume(Number((e.target as HTMLInputElement).value) / 100)}
                />
                <span class="vol-num">{volume}</span>
            </div>
            <div class="row">
                <button class="btn" onClick={() => setVolume(p.volume - 0.1)}>Leiser</button>
                <button class="btn" onClick={() => setVolume((p.muted ? 0 : p.volume) + 0.1)}>Lauter</button>
            </div>

            {(p.audioTracks.length > 1 || p.textTracks.length > 1) && (
                <div class="tracks">
                    {p.audioTracks.length > 1 && (
                        <label>
                            Audio
                            <select value={p.audioTrackId ?? ''} onChange={(e) => send({ type: 'player.setAudioTrack', id: (e.target as HTMLSelectElement).value })}>
                                {p.audioTracks.map((t) => <option value={t.id}>{t.label}</option>)}
                            </select>
                        </label>
                    )}
                    {p.textTracks.length > 1 && (
                        <label>
                            Untertitel
                            <select value={p.textTrackId ?? ''} onChange={(e) => send({ type: 'player.setTextTrack', id: (e.target as HTMLSelectElement).value })}>
                                {p.textTracks.map((t) => <option value={t.id}>{t.label}</option>)}
                            </select>
                        </label>
                    )}
                </div>
            )}

            <div class="row footer">
                <IconButton icon="back" label="Zurück zur Übersicht" onClick={() => send({ type: 'player.exit' })} />
                <IconButton
                    icon={fullscreen ? 'fullscreenExit' : 'fullscreen'}
                    label={fullscreen ? 'Vollbild beenden' : 'Vollbild'}
                    onClick={() => send({ type: 'app.fullscreen', on: !fullscreen })}
                />
            </div>
        </div>
    );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register('./sw.js');
}
