// Film browser on the phone: shows what Netflix displays on the PC (rows,
// search results, profiles, title details with episodes) and acts on it there.

import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    Billboard,
    Catalog,
    CatalogCommand,
    CatalogItem,
    CatalogSection,
    Command,
    CommandResult,
    RemoteState,
    TitleDetail,
} from '../../shared/protocol';
import { sectionOf } from '../../shared/protocol';
import { Icon } from './icons';
import { RatingsRow } from './ratings-view';

type Send = (cmd: Command) => void;
type Query = (cmd: CatalogCommand) => Promise<CommandResult>;

const PAGE_SIZE = 6;
/** Netflix renders lazily after navigation; retry a few times while nothing is there yet. */
const EMPTY_RETRIES = 4;
const RETRY_MS = 1200;
/** Netflix builds the billboard and starts its trailer only after the first rows; ask again a few times. */
const LATE_RETRIES = 8;
const LATE_MS = 1000;

const SECTIONS: { id: CatalogSection; label: string }[] = [
    { id: 'home', label: 'Start' },
    { id: 'series', label: 'Serien' },
    { id: 'movies', label: 'Filme' },
    { id: 'new', label: 'Neu' },
    { id: 'mylist', label: 'Meine Liste' },
];

function isEmpty(c: Catalog) {
    return !c.rows.length && !c.profiles.length && !c.detail?.title && !c.detail?.episodes.length;
}

/** A details page also shows the rows behind the dialog; it is only complete once the details are there. */
function isComplete(c: Catalog) {
    return !isEmpty(c) && (c.page !== 'title' || !!c.detail?.title || !!c.detail?.episodes.length);
}

function useCatalog(state: RemoteState, query: Query) {
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);

    const load = async (retries = EMPTY_RETRIES) => {
        const gen = ++generation.current;
        setLoading(true);
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS));
            if (gen !== generation.current) return;
            const res = await query({ type: 'catalog.get', offset: 0, limit: PAGE_SIZE });
            if (gen !== generation.current) return;
            const data = res.ok ? (res.data as Catalog) : null;
            setError(res.ok ? null : (res.error ?? 'Unbekannter Fehler'));
            if (data) setCatalog(data);
            if (data && isComplete(data)) break;
        }
        if (gen !== generation.current) return;
        setLoading(false);
        void loadLate(gen);
        void settleSearch(gen);
        void settleDetail(gen);
    };

    /**
     * Details: Netflix shows title and synopsis first and fills in the episodes (and seasons) a moment
     * later. Keep asking until episodes are there and stay the same twice in a row; a film has none, so
     * for it this only runs out the retries.
     */
    const settleDetail = async (gen: number) => {
        const signature = (c: Catalog | null) => {
            const d = c?.detail;
            return d ? [d.title, d.year, d.seasons.join('|'), d.season, d.episodes.map((e) => `${e.label}${e.title}${e.img}`).join('|')].join('#') : '';
        };
        let current: Catalog | null = null;
        setCatalog((c) => (current = c));
        if ((current as Catalog | null)?.page !== 'title') return;
        let unchanged = 0;
        for (let attempt = 0; attempt < LATE_RETRIES; attempt++) {
            if (unchanged >= 2 && (current as Catalog | null)?.detail?.episodes.length) return;
            await new Promise((r) => setTimeout(r, LATE_MS));
            if (gen !== generation.current) return;
            const res = await query({ type: 'catalog.get', offset: 0, limit: PAGE_SIZE });
            if (gen !== generation.current || !res.ok) return;
            const data = res.data as Catalog;
            if (data.page !== 'title') return;
            if (signature(data) === signature(current) || !data.detail) {
                unchanged++;
                continue;
            }
            unchanged = 0;
            current = data;
            setCatalog(data);
        }
    };

    /**
     * Search results: after navigating, Netflix first shows other titles and replaces them with the
     * results a moment later. Keep asking until the list stays the same twice in a row.
     */
    const settleSearch = async (gen: number) => {
        const ids = (c: Catalog | null) => c?.rows.flatMap((r) => r.items.map((i) => i.id)).join() ?? '';
        let current: Catalog | null = null;
        setCatalog((c) => (current = c));
        if ((current as Catalog | null)?.page !== 'search') return;
        let unchanged = 0;
        for (let attempt = 0; attempt < LATE_RETRIES && unchanged < 2; attempt++) {
            await new Promise((r) => setTimeout(r, LATE_MS));
            if (gen !== generation.current) return;
            const res = await query({ type: 'catalog.get', offset: 0, limit: PAGE_SIZE });
            if (gen !== generation.current || !res.ok) return;
            const data = res.data as Catalog;
            if (data.page !== 'search') return;
            if (ids(data) === ids(current) || !data.rows.length) {
                unchanged++;
                continue;
            }
            unchanged = 0;
            current = data;
            setCatalog(data);
        }
    };

    /** Adds the billboard and the preview sound state once Netflix has them, without rebuilding the rows. */
    const loadLate = async (gen: number) => {
        // `undefined` means an extension that does not report these at all.
        const missing = (c: Catalog | null) =>
            !!c && c.page === 'browse' && (c.billboard === null || (c.billboard != null && c.previewMuted === null));
        let current: Catalog | null = null;
        setCatalog((c) => (current = c));
        for (let attempt = 0; attempt < LATE_RETRIES && missing(current); attempt++) {
            await new Promise((r) => setTimeout(r, LATE_MS));
            if (gen !== generation.current) return;
            const res = await query({ type: 'catalog.get', offset: 0, limit: 1 });
            if (gen !== generation.current || !res.ok) return;
            const data = res.data as Catalog;
            if (data.page !== 'browse') return;
            setCatalog((c) => (current = c && { ...c, billboard: data.billboard, previewMuted: data.previewMuted }));
        }
    };

    // Reload whenever Netflix on the PC shows another page.
    useEffect(() => {
        void load();
    }, [state.page, state.location]);

    const more = async () => {
        if (!catalog) return;
        setLoading(true);
        if (catalog.rows.length >= catalog.totalRows) await query({ type: 'catalog.loadMore' });
        const res = await query({ type: 'catalog.get', offset: catalog.rows.length, limit: PAGE_SIZE });
        const data = res.ok ? (res.data as Catalog) : null;
        if (data) setCatalog({ ...data, rows: [...catalog.rows, ...data.rows] });
        setLoading(false);
    };

    return { catalog, loading, error, reload: () => load(1), more };
}

export function CatalogView({ state, send, query }: { state: RemoteState; send: Send; query: Query }) {
    const { catalog, loading, error, reload, more } = useCatalog(state, query);
    const empty = <Empty loading={loading} error={error} onReload={reload} query={query} />;
    const [selected, setSelected] = useState<CatalogItem | null>(null);
    // Follows the PC, so the mark is right even when someone navigates there directly.
    const current = sectionOf(state.location);

    // Actions that change the page without changing the URL (seasons) need a manual refresh.
    const act = (cmd: CatalogCommand, refresh = false) => {
        send(cmd);
        if (refresh) setTimeout(reload, 900);
    };

    if (state.page === 'profiles') {
        return (
            <div class="catalog">
                <h2 class="catalog-heading">Wer schaut gerade?</h2>
                <div class="profiles">
                    {catalog?.profiles.map((p) => (
                        <button class="profile" onClick={() => act({ type: 'catalog.profile', index: p.index })}>
                            {p.img ? <img src={p.img} alt="" referrerpolicy="no-referrer" /> : <span class="avatar" />}
                            <span>{p.name}</span>
                        </button>
                    ))}
                </div>
                {!catalog?.profiles.length && empty}
            </div>
        );
    }

    return (
        <div class="catalog">
            <SearchBar onSearch={(q) => act({ type: 'catalog.search', q })} />
            <nav class="chips">
                {SECTIONS.map((s) => (
                    <button
                        class={s.id === current ? 'chip active' : 'chip'}
                        aria-current={s.id === current ? 'page' : undefined}
                        onClick={() => act({ type: 'catalog.nav', section: s.id })}
                    >
                        {s.label}
                    </button>
                ))}
            </nav>

            {state.page === 'title' && catalog?.detail ? (
                <DetailView detail={catalog.detail} muted={catalog.previewMuted} act={act} />
            ) : (
                <>
                    {state.page === 'search' && <h2 class="catalog-heading">Suchergebnisse</h2>}
                    {state.page === 'browse' && catalog?.billboard && (
                        <Hero
                            billboard={catalog.billboard}
                            muted={catalog.previewMuted}
                            onSound={(muted) => act({ type: 'catalog.previewSound', muted }, true)}
                            onPlay={(id) => act({ type: 'catalog.play', id })}
                            onDetails={(id) => act({ type: 'catalog.open', id })}
                        />
                    )}
                    {catalog?.rows.map((row) => (
                        <section class="cat-row">
                            {row.title && <h3>{row.title}</h3>}
                            <div class="strip">
                                {row.items.map((item) => (
                                    <Card item={item} onClick={() => setSelected(item)} />
                                ))}
                            </div>
                        </section>
                    ))}
                    {catalog && !isEmpty(catalog) && state.page !== 'search' && (
                        <button class="btn more" disabled={loading} onClick={more}>
                            {loading ? 'Lädt …' : 'Weitere Reihen laden'}
                        </button>
                    )}
                    {(!catalog || isEmpty(catalog)) && empty}
                </>
            )}

            {selected && (
                <ItemSheet
                    item={selected}
                    onClose={() => setSelected(null)}
                    onPlay={() => {
                        act({ type: 'catalog.play', id: selected.id });
                        setSelected(null);
                    }}
                    onDetails={() => {
                        act({ type: 'catalog.open', id: selected.id });
                        setSelected(null);
                    }}
                />
            )}
        </div>
    );
}

function SearchBar({ onSearch }: { onSearch: (q: string) => void }) {
    const [q, setQ] = useState('');
    return (
        <form
            class="search"
            role="search"
            onSubmit={(e) => {
                e.preventDefault();
                if (q.trim()) onSearch(q.trim());
                (document.activeElement as HTMLElement | null)?.blur();
            }}
        >
            <Icon name="search" size={20} />
            <input
                type="search"
                enterKeyHint="search"
                placeholder="Titel, Personen, Genres"
                aria-label="Suche"
                value={q}
                onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            />
        </form>
    );
}

/** Netflix's large recommendation, full width like on the PC (where its trailer is playing). */
/** Mutes or unmutes the trailer preview on the PC; hidden while no preview plays. */
function SoundButton({ muted, onSound, overlay = false }: {
    muted: boolean | null | undefined;
    onSound: (muted: boolean) => void;
    overlay?: boolean;
}) {
    if (muted == null) return null;
    return (
        <button
            class={overlay ? 'sound-btn overlay' : 'sound-btn'}
            aria-label={muted ? 'Vorschau-Ton einschalten' : 'Vorschau-Ton ausschalten'}
            aria-pressed={muted}
            onClick={() => onSound(!muted)}
        >
            <Icon name={muted ? 'volOff' : 'volUp'} size={22} />
        </button>
    );
}

function Hero({ billboard, muted, onSound, onPlay, onDetails }: {
    billboard: Billboard;
    muted: boolean | null | undefined;
    onSound: (muted: boolean) => void;
    onPlay: (id: string) => void;
    onDetails: (id: string) => void;
}) {
    return (
        <section class="hero" aria-label={`Empfehlung: ${billboard.title}`}>
            <div class="hero-media">
                {billboard.img && <img class="hero-img" src={billboard.img} alt="" referrerpolicy="no-referrer" />}
                <div class="hero-shade" />
                <SoundButton muted={muted} onSound={onSound} overlay />
                <div class="hero-title">
                    {billboard.logo ? (
                        <img class="hero-logo" src={billboard.logo} alt={billboard.title} referrerpolicy="no-referrer" />
                    ) : (
                        <h2>{billboard.title}</h2>
                    )}
                </div>
            </div>
            <div class="hero-ratings">
                <RatingsRow title={billboard.title} id={billboard.id} />
            </div>
            {billboard.synopsis && <p class="hero-synopsis muted">{billboard.synopsis}</p>}
            <div class="row hero-actions">
                <button class="btn primary" onClick={() => onPlay(billboard.id)}>
                    <Icon name="play" size={20} /> Abspielen
                </button>
                <button class="btn" onClick={() => onDetails(billboard.id)}>
                    <Icon name="info" size={20} /> Weitere Infos
                </button>
            </div>
        </section>
    );
}

function Progress({ value }: { value: number | null }) {
    if (value == null || value <= 0) return null;
    return (
        <div class="progress">
            <div style={{ width: `${Math.round(value * 100)}%` }} />
        </div>
    );
}

function Card({ item, onClick }: { item: CatalogItem; onClick: () => void }) {
    return (
        <button class="card" onClick={onClick} aria-label={item.name}>
            <div class="poster">
                {item.img ? <img src={item.img} alt="" loading="lazy" referrerpolicy="no-referrer" /> : <span>{item.name}</span>}
                <Progress value={item.progress} />
            </div>
            <span class="card-name">{item.name}</span>
        </button>
    );
}

function ItemSheet({ item, onClose, onPlay, onDetails }: {
    item: CatalogItem;
    onClose: () => void;
    onPlay: () => void;
    onDetails: () => void;
}) {
    return (
        <div class="sheet-backdrop" onClick={onClose}>
            <div class="sheet" role="dialog" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
                {item.img && <img class="sheet-img" src={item.img} alt="" referrerpolicy="no-referrer" />}
                <h2>{item.name}</h2>
                <RatingsRow title={item.name} id={item.id} showMissing />
                <div class="row">
                    <button class="btn primary" onClick={onPlay}>
                        <Icon name="play" size={20} /> Abspielen
                    </button>
                    <button class="btn" onClick={onDetails}>
                        <Icon name="info" size={20} /> Details &amp; Folgen
                    </button>
                </div>
                <button class="sheet-close" aria-label="Schließen" onClick={onClose}>
                    <Icon name="close" />
                </button>
            </div>
        </div>
    );
}

function DetailView({ detail, muted, act }: {
    detail: TitleDetail;
    muted: boolean | null | undefined;
    act: (cmd: CatalogCommand, refresh?: boolean) => void;
}) {
    return (
        <div class="detail">
            {detail.img && <img class="detail-img" src={detail.img} alt="" referrerpolicy="no-referrer" />}
            <h2>{detail.title || 'Titel'}</h2>
            <RatingsRow
                title={detail.title}
                id={detail.id}
                kind={detail.seasons.length || detail.episodes.length > 1 ? 'series' : undefined}
                year={detail.year}
                hint
                showMissing
            />
            {detail.synopsis && <p class="muted">{detail.synopsis}</p>}
            <div class="row">
                {detail.id && (
                    <button class="btn primary" onClick={() => act({ type: 'catalog.play', id: detail.id! })}>
                        <Icon name="play" size={20} /> Abspielen
                    </button>
                )}
                <button class="btn" onClick={() => act({ type: 'catalog.back' })}>
                    <Icon name="back" size={20} /> Zurück
                </button>
                <SoundButton muted={muted} onSound={(m) => act({ type: 'catalog.previewSound', muted: m }, true)} />
            </div>

            {detail.seasons.length > 1 && (
                <select
                    class="season"
                    aria-label="Staffel"
                    value={String(detail.season)}
                    onChange={(e) => act({ type: 'catalog.season', index: Number((e.target as HTMLSelectElement).value) }, true)}
                >
                    {detail.seasons.map((s, i) => (
                        <option value={String(i)}>{s}</option>
                    ))}
                </select>
            )}
            {detail.seasons.length === 1 && <p class="muted">{detail.seasons[0]}</p>}

            <ol class="episodes">
                {detail.episodes.map((ep) => (
                    <li>
                        <button class="episode" onClick={() => act({ type: 'catalog.episode', index: ep.index })}>
                            <div class="poster small">
                                {ep.img && <img src={ep.img} alt="" loading="lazy" referrerpolicy="no-referrer" />}
                                <Progress value={ep.progress} />
                            </div>
                            <div class="episode-text">
                                <strong>
                                    {ep.label}. {ep.title}
                                </strong>
                                {ep.synopsis && <span class="muted">{ep.synopsis}</span>}
                            </div>
                        </button>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function Empty({ loading, error, onReload, query }: {
    loading: boolean;
    error: string | null;
    onReload: () => void;
    query: Query;
}) {
    return (
        <div class="center empty">
            {loading ? (
                <div class="spinner" />
            ) : (
                <>
                    <p class="muted">
                        {error
                            ? `Der PC hat nicht geantwortet: ${error}`
                            : 'Hier ist gerade nichts zu sehen. Netflix lädt am PC vielleicht noch.'}
                    </p>
                    <button class="btn" onClick={onReload}>
                        <Icon name="refresh" size={20} /> Aktualisieren
                    </button>
                    <Diagnose query={query} />
                </>
            )}
        </div>
    );
}

/** Shows how the extension sees the Netflix page, so users can send it when the catalog stays empty. */
export function Diagnose({ query }: { query: Query }) {
    const [report, setReport] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const run = async () => {
        const res = await query({ type: 'catalog.debug' });
        setReport(res.ok ? JSON.stringify(res.data, null, 1) : `Fehler: ${res.error ?? 'keine Antwort'}`);
    };
    if (!report) {
        return (
            <button class="link" onClick={run}>
                Diagnose anzeigen
            </button>
        );
    }
    return (
        <div class="diagnose">
            <textarea readOnly value={report} rows={12} aria-label="Diagnose" />
            <button
                class="btn"
                onClick={async () => {
                    await navigator.clipboard?.writeText(report).catch(() => {});
                    setCopied(true);
                }}
            >
                {copied ? 'Kopiert ✓' : 'Kopieren'}
            </button>
        </div>
    );
}
