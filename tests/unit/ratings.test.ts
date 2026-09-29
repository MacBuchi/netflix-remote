// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractOmdbKey, fetchRatings, parseOmdb, pickCandidate, setOmdbKey, testOmdbKey, type Candidate } from '../../remote/src/ratings';

const FULL = {
    Response: 'True',
    Title: 'Inception',
    Year: '2010',
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
        expect(parseOmdb(FULL)).toEqual({ imdbId: 'tt1375666', imdb: '8.8', rottenTomatoes: '87%', metacritic: '74', match: 'Inception (2010)' });
    });

    it('keeps only what is available (series usually have just IMDb)', () => {
        const series = { Response: 'True', imdbID: 'tt5753856', imdbRating: '8.7', Metascore: 'N/A', Ratings: [{ Source: 'Internet Movie Database', Value: '8.7/10' }] };
        expect(parseOmdb(series)).toEqual({ imdbId: 'tt5753856', imdb: '8.7', rottenTomatoes: null, metacritic: null, match: null });
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

describe('extractOmdbKey', () => {
    it('takes the key from a pasted OMDb link or the e-mail text', () => {
        expect(extractOmdbKey(' abcd1234 ')).toEqual({ key: 'abcd1234', fromUrl: false, activation: false });
        expect(extractOmdbKey('http://www.omdbapi.com/?i=tt3896198&apikey=abcd1234')).toEqual({ key: 'abcd1234', fromUrl: true, activation: false });
        expect(extractOmdbKey('Here is your key: abcd1234')).toMatchObject({ key: 'abcd1234', fromUrl: false });
    });

    it('recognizes the activation link, which is not the key', () => {
        expect(extractOmdbKey('http://www.omdbapi.com/apikey.aspx?VERIFYKEY=1f2e3d4c-aaaa')).toMatchObject({ key: '', activation: true });
    });
});

const film = (imdb: string, year: number | null, extra: Partial<Candidate> = {}): Candidate => ({ imdb, year, series: false, netflix: null, ...extra });

describe('pickCandidate', () => {
    // "Die Unschuldigen" is the German name of several films.
    const innocents = [film('tt4370784', 2016), film('tt0093261', 1987), film('tt8100954', 2019)];

    it('takes the work Wikidata knows by the Netflix id', () => {
        expect(pickCandidate([...innocents, film('tt1', 2021, { netflix: '81' })], '81', {})).toMatchObject({ imdb: 'tt1' });
    });

    it('tells works of the same name apart by year, and admits when it cannot', () => {
        expect(pickCandidate(innocents, null, { year: 2019 })).toMatchObject({ imdb: 'tt8100954' });
        expect(pickCandidate(innocents, null, { year: 2016, kind: 'movie' })).toMatchObject({ imdb: 'tt4370784' });
        expect(pickCandidate(innocents, null, {})).toBe('ambiguous');
        expect(pickCandidate(innocents, null, { year: 2005 })).toBeNull();
        expect(pickCandidate([film('tt4370784', 2016)], null, {})).toMatchObject({ imdb: 'tt4370784' });
    });

    it('matches series by start, since Netflix shows the latest season year', () => {
        const dark = [film('tt5753856', 2017, { series: true }), film('tt0000001', 2020)];
        expect(pickCandidate(dark, null, { year: 2020, kind: 'series' })).toMatchObject({ imdb: 'tt5753856' });
        expect(pickCandidate(dark, null, { kind: 'series' })).toMatchObject({ imdb: 'tt5753856' });
        expect(pickCandidate(dark, null, { year: 2016, kind: 'series' })).toBeNull();
    });
});

describe('fetchRatings', () => {
    const fetchMock = vi.fn();
    /** Wikidata answers: by Netflix id (P1874) and by name (entity search). */
    let byNetflixId: any[] = [];
    let byName: any[] = [];
    let omdbBody: any = FULL;
    const sparqlOf = (url: string) => new URL(url).searchParams.get('query') ?? '';
    beforeEach(() => {
        localStorage.clear();
        byNetflixId = [];
        byName = [];
        omdbBody = FULL;
        fetchMock.mockReset().mockImplementation(async (url: string) => ({
            json: async () =>
                url.startsWith('https://query.wikidata.org/')
                    ? { results: { bindings: sparqlOf(url).includes('EntitySearch') ? byName : byNetflixId } }
                    : omdbBody,
        }));
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        setOmdbKey(null);
    });
    const omdbCalls = () => fetchMock.mock.calls.map(([u]) => new URL(u)).filter((u) => u.origin === 'https://www.omdbapi.com');
    const named = (imdb: string, year: number, series = false) => ({
        id: { value: imdb },
        year: { value: String(year) },
        series: { value: String(series) },
    });

    it('asks nothing without a key', async () => {
        expect((await fetchRatings('Inception')).ratings).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('function test looks up a known film with the given key', async () => {
        omdbBody = { ...FULL, Title: 'The Shawshank Redemption', imdbRating: '9.3' };
        await expect(testOmdbKey(' k3y ')).resolves.toEqual({
            title: 'The Shawshank Redemption',
            ratings: expect.objectContaining({ imdb: '9.3' }),
        });
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('apikey')).toBe('k3y');

        omdbBody = { Response: 'False', Error: 'Invalid API key!' };
        await expect(testOmdbKey('bad')).rejects.toBe('key');
    });

    it('maps the Netflix id to the IMDb id via Wikidata, then answers from the cache', async () => {
        setOmdbKey(' abc123 ');
        byNetflixId = [{ imdb: { value: 'tt6468322' } }];
        expect((await fetchRatings('Haus des Geldes', '80192098', { kind: 'series' })).ratings?.imdb).toBe('8.8');
        expect(sparqlOf(fetchMock.mock.calls[0][0])).toContain('wdt:P1874 "80192098"');
        expect(Object.fromEntries(omdbCalls()[0].searchParams)).toEqual({ apikey: 'abc123', i: 'tt6468322' });

        // The details (with the year) reuse the answer: card and details show the same numbers.
        expect((await fetchRatings('Haus des Geldes', '80192098', { kind: 'series', year: 2021 })).ratings?.imdb).toBe('8.8');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('finds localized titles by name in Wikidata and looks them up by IMDb id', async () => {
        setOmdbKey('abc123');
        byName = [named('tt4370784', 2016), named('tt8100954', 2019)];
        const card = await fetchRatings('Die Unschuldigen', '81000001');
        expect(card).toEqual({ ratings: null, ambiguous: true });
        expect(omdbCalls()).toHaveLength(0);
        expect(sparqlOf(fetchMock.mock.calls[1][0])).toContain('mwapi:search "Die Unschuldigen"');

        // The details know the year and decide; the guess-free card answer does not stand in the way.
        const details = await fetchRatings('Die Unschuldigen', '81000001', { kind: 'movie', year: 2019 });
        expect(details.ratings?.imdb).toBe('8.8');
        expect(omdbCalls()[0].searchParams.get('i')).toBe('tt8100954');
    });

    it('uses OMDb title search only with a year to check the answer', async () => {
        setOmdbKey('abc123');
        expect((await fetchRatings('Inception', '70131314')).ratings).toBeNull();
        expect(omdbCalls()).toHaveLength(0);

        expect((await fetchRatings('Inception', '70131314', { kind: 'movie', year: 2010 })).ratings?.imdb).toBe('8.8');
        expect(Object.fromEntries(omdbCalls()[0].searchParams)).toEqual({ apikey: 'abc123', t: 'Inception', type: 'movie', y: '2010' });

        localStorage.clear();
        expect((await fetchRatings('Inception', '70131315', { kind: 'movie', year: 2020 })).ratings).toBeNull();
    });

    it('asks once for the same title at the same time', async () => {
        setOmdbKey('abc123');
        byNetflixId = [{ imdb: { value: 'tt6468322' } }];
        const [a, b] = await Promise.all([fetchRatings('Haus des Geldes', '80192098'), fetchRatings('Haus des Geldes', '80192098')]);
        expect(a).toBe(b);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('caches misses too, but not errors', async () => {
        setOmdbKey('abc123');
        omdbBody = { Response: 'False', Error: 'Movie not found!' };
        byNetflixId = [{ imdb: { value: 'tt1' } }];
        expect((await fetchRatings('Unbekannt', '1')).ratings).toBeNull();
        expect((await fetchRatings('Unbekannt', '1')).ratings).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        omdbBody = { Response: 'False', Error: 'Request limit reached!' };
        await expect(fetchRatings('Anderer Titel', '2')).rejects.toBe('limit');
        await expect(fetchRatings('Anderer Titel', '2')).rejects.toBe('limit');
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });
});
