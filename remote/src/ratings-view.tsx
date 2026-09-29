// Compact ratings chips (IMDb, Rotten Tomatoes, Metacritic) – each only when OMDb knows it.

import { openSettings, useRatings, type Kind } from './ratings';

const decimal = (v: string) => v.replace('.', ',');

export function RatingsRow({ title, id, kind, year, hint = false, showMissing = false }: {
    title: string | null | undefined;
    /** Netflix id; mapped to the IMDb id via Wikidata, which also finds localized titles. */
    id?: string | null;
    kind?: Kind;
    /** Release year from the details; tells works of the same name apart. */
    year?: number | null;
    hint?: boolean;
    /** Also say when nothing was found, and which work the numbers belong to (sheet and details). */
    showMissing?: boolean;
}) {
    const { ratings, error, enabled, done, ambiguous } = useRatings(title, id, { kind, year });
    if (!enabled) {
        return hint ? (
            <button class="link ratings-note" onClick={openSettings}>
                Bewertungen von IMDb, Rotten Tomatoes und Metacritic anzeigen …
            </button>
        ) : null;
    }
    if (error === 'key') {
        return (
            <button class="link ratings-note" onClick={openSettings}>
                OMDb-Schlüssel ungültig – Einstellungen öffnen
            </button>
        );
    }
    if (error === 'limit') return <p class="ratings-note">OMDb-Tageslimit erreicht, morgen wieder.</p>;
    if (error === 'network') return showMissing ? <p class="ratings-note">Bewertungen gerade nicht erreichbar.</p> : null;
    if (!ratings) {
        if (!showMissing || !done) return null;
        return <p class="ratings-note">{ambiguous ? 'Mehrere Titel dieses Namens – Bewertungen in den Details.' : 'Keine Bewertungen gefunden.'}</p>;
    }
    const imdbUrl = ratings.imdbId ? `https://www.imdb.com/title/${ratings.imdbId}/` : undefined;
    return (
        <div class="ratings" aria-label="Bewertungen">
            {ratings.imdb && (
                <a class="rating imdb" href={imdbUrl} target="_blank" rel="noopener noreferrer" aria-label={`IMDb ${decimal(ratings.imdb)} von 10`}>
                    <b>IMDb</b> {decimal(ratings.imdb)}
                </a>
            )}
            {ratings.rottenTomatoes && (
                <span class="rating" aria-label={`Rotten Tomatoes ${ratings.rottenTomatoes}`}>
                    <span aria-hidden="true">🍅</span> {ratings.rottenTomatoes.replace('%', ' %')}
                </span>
            )}
            {ratings.metacritic && (
                <span class="rating" aria-label={`Metacritic ${ratings.metacritic} von 100`}>
                    <b>MC</b> {ratings.metacritic}
                </span>
            )}
            {showMissing && ratings.match && <span class="ratings-match">{ratings.match}</span>}
        </div>
    );
}
