// Ratings from IMDb, Rotten Tomatoes and Metacritic via OMDb (www.omdbapi.com). Each user enters an own
// free OMDb key; without one nothing is requested. OMDb does not know Netflix ids and only English
// titles, while Netflix shows localized ones. So the IMDb id comes from Wikidata: by Netflix id
// (P1874 → IMDb ID P345) when Wikidata has it, else by the localized name (labels and aliases),
// told apart by kind and year. OMDb's own title search is the last resort.
// Results are cached on the phone to stay within the daily limit of free keys.

import { useEffect, useState } from 'preact/hooks';

export interface Ratings {
    imdbId: string | null;
    /** "8.7" (out of 10) */
    imdb: string | null;
    /** "91%" */
    rottenTomatoes: string | null;
    /** "78" (out of 100) */
    metacritic: string | null;
    /** What OMDb matched, "The Innocents (2016)", so a wrong match is easy to spot. */
    match: string | null;
}

export type Kind = 'movie' | 'series';
export type RatingsError = 'key' | 'limit' | 'network';

const OMDB = 'https://www.omdbapi.com/';
const KEY_STORAGE = 'nfr.omdbKey';
const WIKIDATA = 'https://query.wikidata.org/sparql';
const CACHE_STORAGE = 'nfr.ratings3';
const HIT_TTL = 7 * 24 * 3600_000;
const MISS_TTL = 24 * 3600_000;
const MAX_CACHE = 400;

/** weak: decided without the year; ambiguous: several works of that name. */
type CacheEntry = { at: number; r: Ratings | null; weak?: boolean; ambiguous?: boolean };

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function write(key: string, value: unknown) {
    try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* private mode: settings last for this visit only */
    }
}

// ---- key --------------------------------------------------------------------------------

const listeners = new Set<() => void>();
let omdbKey: string | null = read<string | null>(KEY_STORAGE, null);

export const getOmdbKey = () => omdbKey;

export function setOmdbKey(key: string | null) {
    omdbKey = key?.trim() || null;
    write(KEY_STORAGE, omdbKey);
    listeners.forEach((l) => l());
}

export function useOmdbKey(): string | null {
    const [key, setKey] = useState(omdbKey);
    useEffect(() => {
        const l = () => setKey(omdbKey);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return key;
}

// ---- OMDb -------------------------------------------------------------------------------

const present = (v: unknown): string | null => (typeof v === 'string' && v && v !== 'N/A' ? v : null);

/** Ratings from an OMDb response; null when OMDb found no title. Throws a RatingsError for key/limit problems. */
export function parseOmdb(json: any): Ratings | null {
    if (json?.Response !== 'True') {
        const error = String(json?.Error ?? '');
        if (/api key/i.test(error)) throw 'key' satisfies RatingsError;
        if (/limit/i.test(error)) throw 'limit' satisfies RatingsError;
        return null;
    }
    const list: { Source?: string; Value?: string }[] = Array.isArray(json.Ratings) ? json.Ratings : [];
    const source = (name: string) => present(list.find((r) => r.Source === name)?.Value);
    const r: Ratings = {
        imdbId: present(json.imdbID),
        imdb: present(json.imdbRating) ?? source('Internet Movie Database')?.replace(/\/10$/, '') ?? null,
        rottenTomatoes: source('Rotten Tomatoes'),
        metacritic: present(json.Metascore) ?? source('Metacritic')?.replace(/\/100$/, '') ?? null,
        match: present(json.Title) && (present(json.Year) ? `${json.Title} (${json.Year})` : json.Title),
    };
    return r.imdb || r.rottenTomatoes || r.metacritic ? r : null;
}

async function omdbJson(params: Record<string, string>, key: string): Promise<any> {
    let res: Response;
    try {
        res = await fetch(`${OMDB}?${new URLSearchParams({ apikey: key, ...params })}`, { referrerPolicy: 'no-referrer' });
    } catch {
        throw 'network' satisfies RatingsError;
    }
    // OMDb answers 401 for bad keys, with the reason in the body.
    return res.json().catch(() => null);
}

const omdb = async (params: Record<string, string>, key: string) => parseOmdb(await omdbJson(params, key));

/** Function test for a key: looks up a well-known film and returns its title and ratings. */
export async function testOmdbKey(key: string): Promise<{ title: string; ratings: Ratings }> {
    const json = await omdbJson({ i: 'tt0111161' }, key.trim());
    const ratings = parseOmdb(json);
    if (!ratings) throw 'network' satisfies RatingsError;
    return { title: String(json.Title ?? 'Testtitel'), ratings };
}

/** IMDb id of a Netflix title from Wikidata; null if Wikidata does not know it or is unreachable. */
export async function imdbIdForNetflix(netflixId: string): Promise<string | null> {
    if (!/^\d{1,12}$/.test(netflixId)) return null;
    const query = `SELECT ?imdb WHERE { ?item wdt:P1874 "${netflixId}"; wdt:P345 ?imdb. FILTER(STRSTARTS(?imdb, "tt")) } LIMIT 1`;
    const id = (await sparql(query))[0]?.imdb?.value;
    return typeof id === 'string' && /^tt\d+$/.test(id) ? id : null;
}

async function sparql(query: string): Promise<any[]> {
    try {
        const res = await fetch(`${WIKIDATA}?${new URLSearchParams({ format: 'json', query })}`, {
            headers: { accept: 'application/sparql-results+json' },
            referrerPolicy: 'no-referrer',
        });
        const json = await res.json();
        return Array.isArray(json?.results?.bindings) ? json.results.bindings : [];
    } catch {
        return [];
    }
}

/** A Wikidata work whose label or alias is exactly the title Netflix shows. */
export interface Candidate {
    imdb: string;
    /** First release (films) or start (series). */
    year: number | null;
    series: boolean;
    netflix: string | null;
}

/**
 * Works named exactly like the title, in any language (Netflix shows localized titles, Wikidata knows
 * them as labels and aliases), in Wikidata's search order. Only works with an IMDb title id count.
 */
export async function wikidataCandidates(title: string, lang: string): Promise<Candidate[]> {
    const literal = JSON.stringify(title);
    const query = `SELECT ?item (MIN(?num) AS ?rank) (SAMPLE(?imdb) AS ?id) (MIN(?y) AS ?year) (MAX(?s) AS ?series) (SAMPLE(?nf) AS ?netflix) WHERE {
  SERVICE wikibase:mwapi { bd:serviceParam wikibase:api "EntitySearch"; wikibase:endpoint "www.wikidata.org";
    mwapi:search ${literal}; mwapi:language "${lang}"; mwapi:limit "20".
    ?item wikibase:apiOutputItem mwapi:item. ?num wikibase:apiOrdinal true. }
  ?item wdt:P345 ?imdb. FILTER(STRSTARTS(?imdb, "tt"))
  FILTER EXISTS { ?item rdfs:label|skos:altLabel ?l. FILTER(LCASE(STR(?l)) = LCASE(${literal})) }
  OPTIONAL { ?item wdt:P577|wdt:P580 ?date. BIND(YEAR(?date) AS ?y) }
  OPTIONAL { ?item wdt:P1874 ?nf }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q5398426 } AS ?s)
} GROUP BY ?item ORDER BY ?rank`;
    return (await sparql(query))
        .map((b) => ({
            imdb: String(b.id?.value ?? ''),
            year: Number(b.year?.value) || null,
            series: b.series?.value === 'true',
            netflix: b.netflix?.value ?? null,
        }))
        .filter((c) => /^tt\d+$/.test(c.imdb));
}

/**
 * The candidate that is this Netflix title, 'ambiguous' when several fit and nothing tells them apart.
 * Netflix shows a film's release year, but a series' latest season, so series only need to have started by then.
 */
export function pickCandidate(candidates: Candidate[], netflixId: string | null | undefined, hints: Hints): Candidate | 'ambiguous' | null {
    const exact = netflixId && candidates.find((c) => c.netflix === netflixId);
    if (exact) return exact;
    const { kind, year } = hints;
    const fits = candidates.filter((c) => {
        if (kind && c.series !== (kind === 'series')) return false;
        if (!year || !c.year) return true;
        return c.series ? c.year <= year : Math.abs(c.year - year) <= 1;
    });
    const ids = new Set(fits.map((c) => c.imdb));
    if (ids.size === 0) return null;
    // Several left: with the year (the details) Wikidata's order decides, without it (a card) nobody can tell.
    return ids.size === 1 || year ? fits[0] : 'ambiguous';
}

/** What Netflix tells about a title besides its name; the details know more than a card. */
export interface Hints {
    kind?: Kind;
    year?: number | null;
}

export interface RatingsResult {
    ratings: Ratings | null;
    /** Several works share the name; the details (with the year) can tell them apart. */
    ambiguous: boolean;
}

const phoneLanguage = () => (typeof navigator !== 'undefined' && navigator.language?.split('-')[0]?.toLowerCase()) || 'de';

/** certain: found by Netflix id, the year cannot change it. */
async function lookup(title: string, netflixId: string | null | undefined, hints: Hints, key: string): Promise<RatingsResult & { certain?: boolean }> {
    // 1. Netflix id → IMDb id: certain.
    const byId = netflixId ? await imdbIdForNetflix(netflixId) : null;
    if (byId) return { ratings: await omdb({ i: byId }, key), ambiguous: false, certain: true };
    if (!title) return { ratings: null, ambiguous: false };

    // 2. The localized title in Wikidata, told apart by kind and year.
    const lang = phoneLanguage();
    let candidates = await wikidataCandidates(title, lang);
    if (!candidates.length && lang !== 'en') candidates = await wikidataCandidates(title, 'en');
    const pick = pickCandidate(candidates, netflixId, hints);
    if (pick === 'ambiguous') return { ratings: null, ambiguous: true };
    if (pick) return { ratings: await omdb({ i: pick.imdb }, key), ambiguous: false };

    // 3. OMDb's own title search only knows English titles and guesses freely; only with the year to check it.
    if (!hints.year) return { ratings: null, ambiguous: false };
    const series = hints.kind === 'series';
    const json = await omdbJson({ t: title, ...(hints.kind ? { type: hints.kind } : {}), ...(series ? {} : { y: String(hints.year) }) }, key);
    const r = parseOmdb(json);
    const start = Number(String(json?.Year ?? '').slice(0, 4));
    const fits = start && (series || json?.Type === 'series' ? start <= hints.year : Math.abs(start - hints.year) <= 1);
    return { ratings: r && fits ? r : null, ambiguous: false };
}

function remember(cache: Record<string, CacheEntry>, id: string, entry: CacheEntry) {
    cache[id] = entry;
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHE) entries.sort((a, b) => a[1].at - b[1].at).slice(0, entries.length - MAX_CACHE).forEach(([k]) => delete cache[k]);
    write(CACHE_STORAGE, cache);
}

const pending = new Map<string, Promise<RatingsResult>>();

/**
 * Ratings for a title: by Netflix id via Wikidata when possible, else by its name in Wikidata, else by
 * OMDb's title search. One answer per Netflix id, so a card and its details show the same numbers; only
 * what was decided without the year (a card) is looked up again once the details know it.
 */
export async function fetchRatings(title: string, netflixId?: string | null, hints: Hints = {}): Promise<RatingsResult> {
    const key = omdbKey;
    if (!key || (!title && !netflixId)) return { ratings: null, ambiguous: false };
    const id = netflixId ? `nf:${netflixId}` : `${hints.kind ?? '*'}:${title.toLowerCase()}`;
    const cache = read<Record<string, CacheEntry>>(CACHE_STORAGE, {});
    const hit = cache[id];
    const fresh = hit && Date.now() - hit.at < (hit.r ? HIT_TTL : MISS_TTL);
    if (fresh && !(hit.weak && hints.year)) return { ratings: hit.r, ambiguous: !!hit.ambiguous };

    const flight = `${id}|${hints.year ?? ''}`;
    let p = pending.get(flight);
    if (!p) {
        p = lookup(title, netflixId, hints, key)
            .then(({ ratings, ambiguous, certain }) => {
                remember(read(CACHE_STORAGE, {}), id, { at: Date.now(), r: ratings, weak: !certain && !hints.year, ambiguous });
                return { ratings, ambiguous };
            })
            .finally(() => pending.delete(flight));
        pending.set(flight, p);
    }
    return p;
}

export function useRatings(title: string | null | undefined, netflixId?: string | null, hints: Hints = {}) {
    const key = useOmdbKey();
    const { kind, year } = hints;
    const [state, setState] = useState<{ ratings: Ratings | null; ambiguous: boolean; error: RatingsError | null; done: boolean }>({
        ratings: null,
        ambiguous: false,
        error: null,
        done: false,
    });
    useEffect(() => {
        setState({ ratings: null, ambiguous: false, error: null, done: false });
        if (!key || (!title && !netflixId)) return;
        let live = true;
        fetchRatings(title ?? '', netflixId, { kind, year }).then(
            (r) => live && setState({ ...r, error: null, done: true }),
            (error: RatingsError) => live && setState({ ratings: null, ambiguous: false, error, done: true }),
        );
        return () => {
            live = false;
        };
    }, [key, title, netflixId, kind, year]);
    return { ...state, enabled: !!key };
}

/**
 * The OMDb key from whatever was pasted: the bare key, the example link from OMDb's e-mail
 * (…?i=tt3896198&apikey=abcd1234) or the whole e-mail text. The activation link (…?VERIFYKEY=…)
 * is not the key; `activation` tells the user to open it instead.
 */
export function extractOmdbKey(input: string): { key: string; fromUrl: boolean; activation: boolean } {
    const text = input.trim();
    const fromParam = text.match(/[?&]apikey=([^&#\s]+)/i)?.[1];
    if (fromParam) return { key: fromParam, fromUrl: true, activation: false };
    if (/VERIFYKEY=/i.test(text)) return { key: '', fromUrl: false, activation: true };
    // "Here is your key: abcd1234" – take the key-shaped word.
    const word = /\s/.test(text) ? text.split(/\s+/).reverse().find((w) => /^[A-Za-z0-9]{8}$/.test(w)) : undefined;
    return { key: word ?? text, fromUrl: false, activation: false };
}

/** Asks the app to show the settings sheet (the ratings setup lives there). */
export const openSettings = () => window.dispatchEvent(new Event('nfr:settings'));
