// Film browser on the phone: shows what Netflix displays on the PC (rows,
// search results, profiles, title details with episodes) and acts on it there.

import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    Catalog,
    CatalogCommand,
    CatalogItem,
    CatalogSection,
    Command,
    CommandResult,
    RemoteState,
    TitleDetail,
} from '../../shared/protocol';
import { Icon } from './icons';

type Send = (cmd: Command) => void;
type Query = (cmd: CatalogCommand) => Promise<CommandResult>;

const PAGE_SIZE = 8;
/** Netflix renders lazily after navigation; retry a few times while nothing is there yet. */
const EMPTY_RETRIES = 4;
const RETRY_MS = 1200;

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

function useCatalog(state: RemoteState, query: Query) {
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [loading, setLoading] = useState(false);
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
            if (data) setCatalog(data);
            if (data && !isEmpty(data)) break;
        }
        if (gen === generation.current) setLoading(false);
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

    return { catalog, loading, reload: () => load(1), more };
}

export function CatalogView({ state, send, query }: { state: RemoteState; send: Send; query: Query }) {
    const { catalog, loading, reload, more } = useCatalog(state, query);
    const [selected, setSelected] = useState<CatalogItem | null>(null);

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
                {!catalog?.profiles.length && <Empty loading={loading} onReload={reload} />}
            </div>
        );
    }

    return (
        <div class="catalog">
            <SearchBar onSearch={(q) => act({ type: 'catalog.search', q })} />
            <nav class="chips">
                {SECTIONS.map((s) => (
                    <button class="chip" onClick={() => act({ type: 'catalog.nav', section: s.id })}>
                        {s.label}
                    </button>
                ))}
            </nav>

            {state.page === 'title' && catalog?.detail ? (
                <DetailView detail={catalog.detail} act={act} />
            ) : (
                <>
                    {state.page === 'search' && <h2 class="catalog-heading">Suchergebnisse</h2>}
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
                    {(!catalog || isEmpty(catalog)) && <Empty loading={loading} onReload={reload} />}
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

function DetailView({ detail, act }: { detail: TitleDetail; act: (cmd: CatalogCommand, refresh?: boolean) => void }) {
    return (
        <div class="detail">
            {detail.img && <img class="detail-img" src={detail.img} alt="" referrerpolicy="no-referrer" />}
            <h2>{detail.title || 'Titel'}</h2>
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

function Empty({ loading, onReload }: { loading: boolean; onReload: () => void }) {
    return (
        <div class="center empty">
            {loading ? (
                <div class="spinner" />
            ) : (
                <>
                    <p class="muted">Hier ist gerade nichts zu sehen. Netflix lädt am PC vielleicht noch.</p>
                    <button class="btn" onClick={onReload}>
                        <Icon name="refresh" size={20} /> Aktualisieren
                    </button>
                </>
            )}
        </div>
    );
}
