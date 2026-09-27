import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    formatTime,
    type CatalogCommand,
    type Command,
    type CommandResult,
    type Pairing,
    type PageKind,
    type PlayerState,
    type RemoteState,
} from '../../shared/protocol';
import { CatalogView } from './catalog';
import { RemoteClient, deviceName, type ClientSnapshot } from './client';
import { Icon, type IconName } from './icons';
import { activePeerId, consumePairingFromUrl, loadPairings, removePairing, setActive } from './pairings';
import { extractOmdbKey, setOmdbKey, testOmdbKey, useOmdbKey, type RatingsError } from './ratings';
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
    const [settings, setSettings] = useState(false);
    const client = useRef<RemoteClient | null>(null);

    useEffect(() => {
        const open = () => setSettings(true);
        window.addEventListener('nfr:settings', open);
        return () => window.removeEventListener('nfr:settings', open);
    }, []);

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
    // Silent request for data (no haptics, no error toast); used by the catalog.
    const query = useMemo(
        () => (cmd: CatalogCommand): Promise<CommandResult> =>
            client.current?.request(cmd) ?? Promise.resolve({ ok: false, error: 'Nicht verbunden' }),
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
            <Header pairings={pairings} active={pairing} snap={snap} onSwitch={switchPc} onSettings={() => setSettings(true)} />
            <main>
                {snap?.status === 'connected' ? (
                    <Connected state={snap.state} send={send} query={query} />
                ) : (
                    <Disconnected snap={snap} onRetry={() => client.current?.wake() ?? undefined} onForget={forget} />
                )}
            </main>
            {toast && <div class="toast">{toast}</div>}
            {settings && <Settings onClose={() => setSettings(false)} />}
        </div>
    );
}

function Header({ pairings, active, snap, onSwitch, onSettings }: {
    pairings: Pairing[];
    active: Pairing;
    snap: ClientSnapshot | null;
    onSwitch: (id: string) => void;
    onSettings: () => void;
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
            {snap?.status === 'connected' && (
                <span class="via" title={snap.via === 'direct' ? 'Direkte Verbindung im Netzwerk' : 'Verschlüsselt über Relay-Server'}>
                    {snap.via === 'direct' ? 'Direkt' : 'Relay'}
                </span>
            )}
            <button class="header-btn" aria-label="Einstellungen" onClick={onSettings}>
                <Icon name="settings" size={22} />
            </button>
        </header>
    );
}

const KEY_ERRORS: Record<RatingsError, string> = {
    key: 'Dieser Schlüssel wird von OMDb nicht angenommen. Ist er schon per E-Mail-Link aktiviert?',
    limit: 'Das Tageslimit dieses Schlüssels ist erreicht.',
    network: 'OMDb ist gerade nicht erreichbar.',
};

/** Ratings setup: each user brings an own free OMDb key; nothing is requested without one. */
function Settings({ onClose }: { onClose: () => void }) {
    const saved = useOmdbKey();
    const [key, setKey] = useState(saved ?? '');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const unchanged = !!saved && key.trim() === saved;

    // Saving always runs the function test, so a working key is confirmed with a real answer.
    const check = async (candidate: string) => {
        setBusy(true);
        setResult(null);
        try {
            const { title, ratings } = await testOmdbKey(candidate);
            setOmdbKey(candidate);
            const imdb = ratings.imdb ? ` – IMDb ${ratings.imdb.replace('.', ',')}` : '';
            setResult({ ok: true, text: `Funktioniert: „${title}“${imdb}. Bewertungen erscheinen jetzt bei Titeln.` });
        } catch (err) {
            setResult({ ok: false, text: KEY_ERRORS[err as RatingsError] ?? String(err) });
        } finally {
            setBusy(false);
        }
    };
    const save = (e: Event) => {
        e.preventDefault();
        void check(extractOmdbKey(key).key);
    };
    // Pasting OMDb's link or e-mail text: take the key out of it and apply it right away.
    const onInput = (value: string) => {
        const found = extractOmdbKey(value);
        if (found.activation) {
            setKey('');
            setResult({ ok: false, text: 'Das ist der Aktivierungslink – bitte im Browser öffnen. Der Schlüssel steht in der E-Mail darüber (8 Zeichen) oder im Beispiel-Link mit „apikey=“.' });
            return;
        }
        if (found.fromUrl || (found.key !== value.trim() && found.key)) {
            setKey(found.key);
            void check(found.key);
            return;
        }
        setKey(value);
    };

    return (
        <div class="sheet-backdrop" onClick={onClose}>
            <div class="sheet settings" role="dialog" aria-label="Einstellungen" onClick={(e) => e.stopPropagation()}>
                <h2>Bewertungen</h2>
                <p class="muted">
                    Zeigt bei Titeln die Bewertungen von IMDb, Rotten Tomatoes und Metacritic. Sie kommen vom Dienst{' '}
                    <a href="https://www.omdbapi.com/" target="_blank" rel="noopener noreferrer">OMDb</a>; dafür brauchst du
                    einen eigenen, kostenlosen Schlüssel (1.000 Abfragen pro Tag).
                </p>
                <ol class="steps key-steps">
                    <li>
                        <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener noreferrer">
                            omdbapi.com/apikey.aspx
                        </a>{' '}
                        öffnen, „FREE! (1,000 daily limit)“ wählen, E-Mail-Adresse und Namen eintragen, absenden.
                    </li>
                    <li>In der E-Mail von OMDb den Aktivierungslink antippen – erst dann gilt der Schlüssel.</li>
                    <li>
                        Den Schlüssel aus der E-Mail (8 Zeichen) hier eintragen und „Speichern & testen“ tippen – oder einfach
                        den Beispiel-Link aus der E-Mail einfügen, der Schlüssel wird dann automatisch übernommen und getestet.
                    </li>
                </ol>
                <form class="key-form" onSubmit={save}>
                    <input
                        aria-label="OMDb-Schlüssel"
                        placeholder="OMDb-Schlüssel"
                        value={key}
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck={false}
                        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
                    />
                    <button class="btn primary" disabled={busy || !key.trim()}>
                        {busy ? 'Teste …' : unchanged ? 'Erneut testen' : 'Speichern & testen'}
                    </button>
                </form>
                {result && (
                    <p class={result.ok ? 'ok-text' : 'error-text'} role="status">
                        {result.ok ? '✓ ' : ''}
                        {result.text}
                    </p>
                )}
                {saved && (
                    <button class="link" onClick={() => (setOmdbKey(null), setKey(''), setResult(null))}>
                        Schlüssel entfernen
                    </button>
                )}
                <p class="muted legal">
                    Mit Schlüssel fragt das Handy OMDb nach den Titelnamen, die du öffnest; Ergebnisse bleiben eine Woche
                    auf dem Handy gespeichert. <a href={`${import.meta.env.BASE_URL}privacy.html`}>Datenschutz</a>
                </p>
                <button class="sheet-close" aria-label="Schließen" onClick={onClose}>
                    <Icon name="close" />
                </button>
            </div>
        </div>
    );
}

function Onboarding() {
    return (
        <div class="app">
            <main class="center">
                <h1>Couch Remote</h1>
                <ol class="steps">
                    <li>Extension „Couch Remote“ in Chrome auf dem PC/Mac installieren.</li>
                    <li>In Chrome auf das Extension-Symbol klicken – ein QR-Code erscheint.</li>
                    <li>QR-Code mit der Handy-Kamera scannen. Fertig – ab dann verbindet sich diese App automatisch.</li>
                </ol>
                <p class="muted">Tipp: Im Browser-Menü „Zum Startbildschirm hinzufügen“ wählen, dann startet die Fernbedienung wie eine App.</p>
                <p class="muted legal">
                    <a href={`${import.meta.env.BASE_URL}privacy.html`}>Datenschutz</a> · Unabhängiges Projekt, nicht mit Netflix
                    verbunden.
                </p>
            </main>
        </div>
    );
}

const STATUS_TEXT: Record<ClientSnapshot['status'], string> = {
    connecting: 'Verbinde …',
    connected: 'Verbunden',
    'pc-offline': 'PC nicht erreichbar. Läuft Chrome auf dem PC? Wurde dort „Neu koppeln“ gedrückt, QR-Code neu scannen.',
    blocked:
        'PC gefunden, aber das WLAN blockiert die direkte Verbindung (typisch für Hotel- und Gäste-WLAN), und der Relay-Server ist gerade nicht erreichbar. Neuer Versuch läuft …',
    offline: 'Keine Verbindung zum Internet. Netz am Handy prüfen.',
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

function Connected({ state, send, query }: {
    state: RemoteState | null;
    send: Send;
    query: (cmd: CatalogCommand) => Promise<CommandResult>;
}) {
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
    if (state.page === 'browse' || state.page === 'search' || state.page === 'title' || state.page === 'profiles') {
        return <CatalogView state={state} send={send} query={query} />;
    }
    return (
        <div class="center">
            <p class="muted">Am PC geöffnet</p>
            <h2>{PAGE_NAMES[state.page]}</h2>
            {state.page === 'login' && <p class="muted">Bitte am PC bei Netflix anmelden.</p>}
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

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const formatRate = (rate: number) => `${String(rate).replace('.', ',')}×`;

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

            {p.playbackRate !== undefined && (
                <div class="speed" role="group" aria-label="Geschwindigkeit">
                    <span class="speed-label">Tempo</span>
                    {SPEEDS.map((rate) => (
                        <button
                            class={Math.abs(p.playbackRate! - rate) < 0.01 ? 'speed-btn active' : 'speed-btn'}
                            aria-pressed={Math.abs(p.playbackRate! - rate) < 0.01}
                            aria-label={`Geschwindigkeit ${formatRate(rate)}`}
                            onClick={() => send({ type: 'player.setRate', rate })}
                        >
                            {formatRate(rate)}
                        </button>
                    ))}
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
