// Compact ratings chips (IMDb, Rotten Tomatoes, Metacritic) – each only when OMDb knows it.

import { openSettings, useRatings, type Kind } from './ratings';

const decimal = (v: string) => v.replace('.', ',');

export function RatingsRow({ title, kind, hint = false }: { title: string | null | undefined; kind?: Kind; hint?: boolean }) {
    const { ratings, error, enabled } = useRatings(title, kind);
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
    if (!ratings) return null;
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
        </div>
    );
}
