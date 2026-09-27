// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRatings, parseOmdb, setOmdbKey, testOmdbKey } from '../../remote/src/ratings';

const FULL = {
    Response: 'True',
    imdbID: 'tt1375666',
    imdbRating: '8.8',
    Metascore: '74',
    Ratings: [
        { Source: 'Internet Movie Database', Value: '8.8/10' },
        { Source: 'Rotten Tomatoes', Value: '87%' },
        { Source: 'Metacritic', Value: '74/100' },
    ],
};

describe('parseOmdb', () => {
    it('reads IMDb, Rotten Tomatoes and Metacritic', () => {
        expect(parseOmdb(FULL)).toEqual({ imdbId: 'tt1375666', imdb: '8.8', rottenTomatoes: '87%', metacritic: '74' });
    });

    it('keeps only what is available (series usually have just IMDb)', () => {
        const series = { Response: 'True', imdbID: 'tt5753856', imdbRating: '8.7', Metascore: 'N/A', Ratings: [{ Source: 'Internet Movie Database', Value: '8.7/10' }] };
        expect(parseOmdb(series)).toEqual({ imdbId: 'tt5753856', imdb: '8.7', rottenTomatoes: null, metacritic: null });
    });

    it('treats unknown titles and titles without any rating as not found', () => {
        expect(parseOmdb({ Response: 'False', Error: 'Movie not found!' })).toBeNull();
        expect(parseOmdb({ Response: 'True', imdbID: 'tt1', imdbRating: 'N/A', Ratings: [] })).toBeNull();
        expect(parseOmdb(null)).toBeNull();
    });

    it('reports key and limit problems', () => {
        expect(() => parseOmdb({ Response: 'False', Error: 'Invalid API key!' })).toThrow();
        expect(() => parseOmdb({ Response: 'False', Error: 'No API key provided.' })).toThrow();
        expect(() => parseOmdb({ Response: 'False', Error: 'Request limit reached!' })).toThrow();
    });
});

describe('fetchRatings', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        localStorage.clear();
        fetchMock.mockReset().mockResolvedValue({ json: async () => FULL });
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        setOmdbKey(null);
    });

    it('asks nothing without a key', async () => {
        expect(await fetchRatings('Inception')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('queries by title and type, then answers from the cache', async () => {
        setOmdbKey(' abc123 ');
        expect((await fetchRatings('Inception', 'movie'))?.imdb).toBe('8.8');
        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.origin).toBe('https://www.omdbapi.com');
        expect(Object.fromEntries(url.searchParams)).toEqual({ apikey: 'abc123', t: 'Inception', type: 'movie' });

        expect((await fetchRatings('inception', 'movie'))?.imdb).toBe('8.8');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('function test looks up a known film with the given key', async () => {
        fetchMock.mockResolvedValue({ json: async () => ({ ...FULL, Title: 'The Shawshank Redemption', imdbRating: '9.3' }) });
        await expect(testOmdbKey(' k3y ')).resolves.toEqual({
            title: 'The Shawshank Redemption',
            ratings: expect.objectContaining({ imdb: '9.3' }),
        });
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('apikey')).toBe('k3y');

        fetchMock.mockResolvedValue({ json: async () => ({ Response: 'False', Error: 'Invalid API key!' }) });
        await expect(testOmdbKey('bad')).rejects.toBe('key');
    });

    it('caches misses too, but not errors', async () => {
        setOmdbKey('abc123');
        fetchMock.mockResolvedValue({ json: async () => ({ Response: 'False', Error: 'Movie not found!' }) });
        expect(await fetchRatings('Unbekannt')).toBeNull();
        expect(await fetchRatings('Unbekannt')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fetchMock.mockResolvedValue({ json: async () => ({ Response: 'False', Error: 'Request limit reached!' }) });
        await expect(fetchRatings('Anderer Titel')).rejects.toBe('limit');
        await expect(fetchRatings('Anderer Titel')).rejects.toBe('limit');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});
