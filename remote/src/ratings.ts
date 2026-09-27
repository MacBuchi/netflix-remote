// Ratings from IMDb, Rotten Tomatoes and Metacritic via OMDb (www.omdbapi.com). Each user enters an own
// free OMDb key; without one nothing is requested. Titles are matched by name (Netflix ids are unknown
// to OMDb), results are cached on the phone to stay within the daily limit of free keys.

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
const CACHE_STORAGE = 'nfr.ratings';
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

async function omdb(params: Record<string, string>, key: string): Promise<Ratings | null> {
    let res: Response;
    try {
        res = await fetch(`${OMDB}?${new URLSearchParams({ apikey: key, ...params })}`, { referrerPolicy: 'no-referrer' });
    } catch {
        throw 'network' satisfies RatingsError;
    }
    // OMDb answers 401 for bad keys, with the reason in the body.
    return parseOmdb(await res.json().catch(() => null));
}

/** Checks a key with a known title; resolves when it works. */
export async function testOmdbKey(key: string): Promise<void> {
    await omdb({ i: 'tt0111161' }, key.trim());
}

const cacheKey = (title: string, kind?: Kind) => `${kind ?? '*'}:${title.toLowerCase()}`;

export async function fetchRatings(title: string, kind?: Kind): Promise<Ratings | null> {
    const key = omdbKey;
    if (!key || !title) return null;
    const cache = read<Record<string, CacheEntry>>(CACHE_STORAGE, {});
    const id = cacheKey(title, kind);
    const hit = cache[id];
    if (hit && Date.now() - hit.at < (hit.r ? HIT_TTL : MISS_TTL)) return hit.r;

    const r = await omdb({ t: title, ...(kind ? { type: kind } : {}) }, key);
    cache[id] = { at: Date.now(), r };
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHE) entries.sort((a, b) => a[1].at - b[1].at).slice(0, entries.length - MAX_CACHE).forEach(([k]) => delete cache[k]);
    write(CACHE_STORAGE, cache);
    return r;
}

export function useRatings(title: string | null | undefined, kind?: Kind) {
    const key = useOmdbKey();
    const [state, setState] = useState<{ ratings: Ratings | null; error: RatingsError | null }>({ ratings: null, error: null });
    useEffect(() => {
        setState({ ratings: null, error: null });
        if (!key || !title) return;
        let live = true;
        fetchRatings(title, kind).then(
            (ratings) => live && setState({ ratings, error: null }),
            (error: RatingsError) => live && setState({ ratings: null, error }),
        );
        return () => {
            live = false;
        };
    }, [key, title, kind]);
    return { ...state, enabled: !!key };
}

/** Asks the app to show the settings sheet (the ratings setup lives there). */
export const openSettings = () => window.dispatchEvent(new Event('nfr:settings'));
