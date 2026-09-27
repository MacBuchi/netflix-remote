// Ratings from IMDb, Rotten Tomatoes and Metacritic via OMDb (www.omdbapi.com). Each user enters an own
// free OMDb key; without one nothing is requested. OMDb does not know Netflix ids, and Netflix shows
// localized titles OMDb often cannot find, so the Netflix id is first mapped to the IMDb id through
// Wikidata (Netflix ID P1874 → IMDb ID P345); only unknown ids fall back to a search by title.
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
}

export type Kind = 'movie' | 'series';
export type RatingsError = 'key' | 'limit' | 'network';

const OMDB = 'https://www.omdbapi.com/';
const KEY_STORAGE = 'nfr.omdbKey';
const WIKIDATA = 'https://query.wikidata.org/sparql';
const CACHE_STORAGE = 'nfr.ratings2';
const HIT_TTL = 7 * 24 * 3600_000;
const MISS_TTL = 24 * 3600_000;
const MAX_CACHE = 400;

type CacheEntry = { at: number; r: Ratings | null };

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
    try {
        const res = await fetch(`${WIKIDATA}?${new URLSearchParams({ format: 'json', query })}`, {
            headers: { accept: 'application/sparql-results+json' },
            referrerPolicy: 'no-referrer',
        });
        const json = await res.json();
        const id = json?.results?.bindings?.[0]?.imdb?.value;
        return typeof id === 'string' && /^tt\d+$/.test(id) ? id : null;
    } catch {
        return null;
    }
}

function remember(cache: Record<string, CacheEntry>, id: string, r: Ratings | null) {
    cache[id] = { at: Date.now(), r };
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHE) entries.sort((a, b) => a[1].at - b[1].at).slice(0, entries.length - MAX_CACHE).forEach(([k]) => delete cache[k]);
    write(CACHE_STORAGE, cache);
}

/** Ratings for a title: by Netflix id via Wikidata when possible, else by name. */
export async function fetchRatings(title: string, kind?: Kind, netflixId?: string | null): Promise<Ratings | null> {
    const key = omdbKey;
    if (!key || (!title && !netflixId)) return null;
    const cache = read<Record<string, CacheEntry>>(CACHE_STORAGE, {});
    const id = netflixId ? `nf:${netflixId}` : `${kind ?? '*'}:${title.toLowerCase()}`;
    const hit = cache[id];
    if (hit && Date.now() - hit.at < (hit.r ? HIT_TTL : MISS_TTL)) return hit.r;

    const imdbId = netflixId ? await imdbIdForNetflix(netflixId) : null;
    let r = imdbId ? await omdb({ i: imdbId }, key) : null;
    if (!r && title) r = await omdb({ t: title, ...(kind ? { type: kind } : {}) }, key);
    remember(cache, id, r);
    return r;
}

export function useRatings(title: string | null | undefined, kind?: Kind, netflixId?: string | null) {
    const key = useOmdbKey();
    const [state, setState] = useState<{ ratings: Ratings | null; error: RatingsError | null; done: boolean }>({
        ratings: null,
        error: null,
        done: false,
    });
    useEffect(() => {
        setState({ ratings: null, error: null, done: false });
        if (!key || (!title && !netflixId)) return;
        let live = true;
        fetchRatings(title ?? '', kind, netflixId).then(
            (ratings) => live && setState({ ratings, error: null, done: true }),
            (error: RatingsError) => live && setState({ ratings: null, error, done: true }),
        );
        return () => {
            live = false;
        };
    }, [key, title, kind, netflixId]);
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
