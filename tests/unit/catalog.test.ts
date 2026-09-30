// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnose, readCatalog, runCatalogCommand, videoIdFromHref } from '../../extension/src/netflix/catalog';

const card = (id: string, name: string, extra = '') => `
    <div class="slider-item"><div class="title-card-container"><div class="title-card">
        <a href="/watch/${id}?tctx=0%2C1" aria-label="${name}" tabindex="0">
            <div class="boxart-container"><img class="boxart-image" src="https://occ-0.nflxso.net/${id}.jpg" alt=""></div>
            <div class="fallback-text-container"><p class="fallback-text">${name}</p></div>
        </a>${extra}
    </div></div></div>`;

const BROWSE = `
    <div class="billboard-row"><a href="/watch/1" aria-label="Abspielen">Abspielen</a></div>
    <div class="lolomoRow" data-list-context="continueWatching">
        <h2 class="rowHeader"><a class="rowTitle"><div class="row-header-title">Weiterschauen für Marcus</div></a></h2>
        ${card('80100172', 'Dark', '<div class="progress"><span class="progress-bar"><span class="progress-completed" style="width: 40%"></span></span></div>')}
        ${card('80057281', 'Stranger Things')}
        ${card('80100172', 'Dark')}
    </div>
    <div class="lolomoRow" data-list-context="trendingNow">
        <h2 class="rowHeader"><div class="row-header-title">Derzeit beliebt</div></h2>
        ${card('81040344', 'Squid Game')}
    </div>
    <div class="lolomoRow" data-list-context="empty"><h2><div class="row-header-title">Leer</div></h2></div>`;

const MODAL = `
    <div class="previewModal--container detail-modal" data-uia="modal-motion-container-DETAIL_MODAL">
        <img class="previewModal--player-titleTreatment-logo" alt="Dark" src="https://occ-0.nflxso.net/logo.png">
        <a data-uia="play-button" href="/watch/80100172">Abspielen</a>
        <button data-uia="previewModal-closebtn" aria-label="close"></button>
        <div class="previewModal--detailsMetadata"><div class="videoMetadata--second-line"><span class="year">2020</span> 3 Staffeln</div></div>
        <p class="preview-modal-synopsis">Ein Kind verschwindet.</p>
        <button data-uia="dropdown-toggle">Staffel 1</button>
        <div class="titleCardList--container episode-item" data-uia="titleCard--container">
            <div class="titleCard-imageWrapper"><img src="https://occ-0.nflxso.net/e1.jpg"></div>
            <div class="titleCard-title_index">1</div>
            <div class="titleCard-title_text">Geheimnisse</div>
            <p class="titleCard-synopsis">Mikkel verschwindet.</p>
        </div>
        <div class="titleCardList--container episode-item" data-uia="titleCard--container">
            <div class="titleCard-title_index">2</div>
            <div class="titleCard-title_text">Lügen</div>
        </div>
        <div class="moreLikeThis--wrapper"><h3>Mehr Titel wie dieser</h3><div class="moreLikeThis--container">
            <div class="titleCard--container more-like-this-item" data-uia="titleCard--container">
                <a href="/watch/80244088"><img src="https://occ-0.nflxso.net/mlt.jpg"></a>
                <div class="titleCard-title_text">1899</div>
            </div>
        </div></div>
    </div>`;

beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', '/browse');
});

describe('videoIdFromHref', () => {
    it('reads ids from watch, title and jbv links', () => {
        expect(videoIdFromHref('/watch/80100172?tctx=1')).toBe('80100172');
        expect(videoIdFromHref('https://www.netflix.com/title/123')).toBe('123');
        expect(videoIdFromHref('/browse?jbv=456&x=1')).toBe('456');
        expect(videoIdFromHref('/browse')).toBeNull();
    });
});

describe('readCatalog', () => {
    it('groups titles into rows with names, images and progress', () => {
        document.body.innerHTML = BROWSE;
        const c = readCatalog(document);
        expect(c.page).toBe('browse');
        expect(c.totalRows).toBe(2);
        expect(c.rows.map((r) => r.title)).toEqual(['Weiterschauen für Marcus', 'Derzeit beliebt']);
        expect(c.rows[0].items).toEqual([
            { id: '80100172', name: 'Dark', img: 'https://occ-0.nflxso.net/80100172.jpg', progress: 0.4 },
            { id: '80057281', name: 'Stranger Things', img: 'https://occ-0.nflxso.net/80057281.jpg', progress: null },
        ]);
    });

    it('pages through rows', () => {
        document.body.innerHTML = BROWSE;
        const c = readCatalog(document, 1, 5);
        expect(c.rows.map((r) => r.title)).toEqual(['Derzeit beliebt']);
        expect(c.totalRows).toBe(2);
    });

    it('collects search results without row headings', () => {
        history.replaceState(null, '', '/search?q=dark');
        document.body.innerHTML = `<div class="search">${card('1', 'A')}${card('2', 'B')}</div>`;
        const c = readCatalog(document);
        expect(c.page).toBe('search');
        expect(c.rows).toHaveLength(1);
        expect(c.rows[0].items.map((i) => i.name)).toEqual(['A', 'B']);
    });

    it('takes only the result grid on the search page, not rows or suggestions around it', () => {
        history.replaceState(null, '', '/search?q=dark');
        document.body.innerHTML = BROWSE + `<div class="search-page"><div class="gallery search">${card('1', 'Dark')}${card('2', 'Dark Matter')}</div></div>`;
        const c = readCatalog(document);
        expect(c.rows.flatMap((r) => r.items.map((i) => i.name))).toEqual(['Dark', 'Dark Matter']);
    });

    it('reads the billboard with logo, synopsis and background image', () => {
        document.body.innerHTML =
            `<div class="billboard-row"><div class="billboard billboard-pane">
                <div class="hero-image-wrapper"><img class="hero static-image" src="https://occ-0.nflxso.net/hero.jpg"></div>
                <div class="billboard-title"><img class="title-logo" alt="The Crown" src="https://occ-0.nflxso.net/logo.png"></div>
                <div class="billboard-description"><div class="synopsis">Königin Elisabeth II.</div></div>
                <div class="billboard-links"><a class="playLink" href="/watch/80025678?trackId=1"><button data-uia="play-button">Abspielen</button></a>
                <button data-uia="billboard-more-info">Weitere Infos</button></div>
            </div></div>` + BROWSE.replace(/<div class="billboard-row">.*?<\/div>/, '');
        const c = readCatalog(document);
        expect(c.billboard).toEqual({
            id: '80025678',
            title: 'The Crown',
            synopsis: 'Königin Elisabeth II.',
            img: 'https://occ-0.nflxso.net/hero.jpg',
            logo: 'https://occ-0.nflxso.net/logo.png',
        });
        expect(c.rows.flatMap((r) => r.items.map((i) => i.id))).not.toContain('80025678');
    });

    it('ignores a billboard without title or image, and has none outside browse pages', () => {
        document.body.innerHTML = BROWSE;
        expect(readCatalog(document).billboard).toBeNull();
        history.replaceState(null, '', '/search?q=x');
        expect(readCatalog(document).billboard).toBeNull();
    });

    it('never takes the cookie settings dialog for title details', () => {
        const COOKIES = `<div id="onetrust-pc-sdk" class="otPcCenter" role="dialog" aria-label="Datenschutz-Präferenz-Center">
            <h3 id="ot-pc-title">Allgemeine Beschreibung</h3>
            <p id="ot-pc-desc">Dieses Cookie-Tool wird Ihnen helfen, zu verstehen, wie Cookies im Netflix-Dienst genutzt werden.</p>
            <button>Alle akzeptieren</button></div>`;
        history.replaceState(null, '', '/browse?jbv=80100172');
        document.body.innerHTML = BROWSE + COOKIES;
        expect(readCatalog(document).detail).toBeNull();

        // Once Netflix renders the real details, those count – with the cookie dialog still in the page.
        document.body.innerHTML = BROWSE + COOKIES + MODAL;
        expect(readCatalog(document).detail).toMatchObject({ title: 'Dark', synopsis: 'Ein Kind verschwindet.' });
    });

    it('accepts a generic dialog as details only when it offers to play a title', () => {
        history.replaceState(null, '', '/browse?jbv=80100172');
        document.body.innerHTML = BROWSE + '<div role="dialog"><h3>Hinweis</h3><p>Irgendetwas</p></div>';
        expect(readCatalog(document).detail).toBeNull();
        document.body.innerHTML = BROWSE + '<div role="dialog"><h3>Dark</h3><p>Ein Kind verschwindet.</p><a href="/watch/80100172">Abspielen</a></div>';
        expect(readCatalog(document).detail).toMatchObject({ title: 'Dark' });
    });

    it('reports and switches the trailer preview sound with Netflix\'s own button', async () => {
        document.body.innerHTML = `<div class="billboard-row"><video></video>
            <button data-uia="audio-toggle-unmuted" aria-label="Ton aus"></button></div>` + BROWSE;
        const video = document.querySelector('video')!;
        const button = document.querySelector('button')!;
        button.addEventListener('click', () => {
            video.muted = !video.muted;
            button.dataset.uia = video.muted ? 'audio-toggle-muted' : 'audio-toggle-unmuted';
        });
        expect(readCatalog(document).previewMuted).toBe(false);
        expect(await runCatalogCommand(document, { type: 'catalog.previewSound', muted: true })).toEqual({ ok: true });
        expect(video.muted).toBe(true);
        expect(readCatalog(document).previewMuted).toBe(true);
        // Already muted: nothing to click.
        await runCatalogCommand(document, { type: 'catalog.previewSound', muted: true });
        expect(video.muted).toBe(true);
    });

    it('mutes previews directly when there is no button, and reports none without a preview', async () => {
        document.body.innerHTML = BROWSE;
        expect(readCatalog(document).previewMuted).toBeNull();
        expect((await runCatalogCommand(document, { type: 'catalog.previewSound', muted: true })).ok).toBe(false);
        document.body.insertAdjacentHTML('afterbegin', '<video></video>');
        await runCatalogCommand(document, { type: 'catalog.previewSound', muted: true });
        expect(document.querySelector('video')!.muted).toBe(true);
    });

    it('reads profiles on the profile gate', () => {
        document.body.innerHTML = `
            <ul class="choose-profile">
                <li><a class="profile-link" data-uia="profile-link" href="/browse"><div class="profile-icon" style="background-image: url('https://occ-0.nflxso.net/avatar1.png')"></div><span class="profile-name">Marcus</span></a></li>
                <li><a class="profile-link" data-uia="profile-link" href="/browse"><div class="profile-icon"></div><span class="profile-name">Kinder</span></a></li>
            </ul>`;
        const c = readCatalog(document);
        expect(c.page).toBe('profiles');
        expect(c.profiles).toEqual([
            { index: 0, name: 'Marcus', img: 'https://occ-0.nflxso.net/avatar1.png' },
            { index: 1, name: 'Kinder', img: null },
        ]);
    });

    it('reads profile avatars that are plain images', () => {
        document.body.innerHTML = `
            <ul class="choose-profile">
                <li><a class="profile-link" data-uia="profile-link" href="#"><img src="https://occ-0.nflxso.net/avatar2.png"><span class="profile-name">Alex</span></a></li>
            </ul>`;
        expect(readCatalog(document).profiles).toEqual([{ index: 0, name: 'Alex', img: 'https://occ-0.nflxso.net/avatar2.png' }]);
    });

    it('reads the title details with episodes and keeps them out of the rows', () => {
        history.replaceState(null, '', '/browse?jbv=80100172');
        document.body.innerHTML = BROWSE + MODAL;
        const c = readCatalog(document);
        expect(c.page).toBe('title');
        expect(c.detail).toMatchObject({
            id: '80100172',
            title: 'Dark',
            synopsis: 'Ein Kind verschwindet.',
            year: 2020,
            seasons: ['Staffel 1'],
            season: 0,
        });
        expect(c.detail!.episodes.map((e) => `${e.label}. ${e.title}`)).toEqual(['1. Geheimnisse', '2. Lügen']);
        expect(c.detail!.episodes[0].synopsis).toBe('Mikkel verschwindet.');
        expect(c.rows.flatMap((r) => r.items).some((i) => i.name === 'Abspielen')).toBe(false);
    });
});

describe('episodes in the details', () => {
    const card = (n: string | null, title: string, cls = 'titleCardList--container episode-item') => `
        <div class="${cls}" data-uia="titleCard--container">
            <a href="/watch/9${title.length}"><img src="https://occ-0.nflxso.net/${title}.jpg"></a>
            ${n ? `<div class="titleCard-title_index">${n}</div>` : ''}
            <div class="titleCard-title_text">${title}</div>
        </div>`;
    const details = (body: string) => {
        history.replaceState(null, '', '/browse?jbv=80100172');
        document.body.innerHTML = `<div class="previewModal--container detail-modal" data-uia="modal-motion-container-DETAIL_MODAL">
            <a data-uia="play-button" href="/watch/80100172">Abspielen</a>${body}</div>`;
        return readCatalog(document).detail!.episodes.map((e) => e.title);
    };

    it('takes the numbered cards, wherever Netflix puts them', () => {
        // Even inside a wrapper that looks like a suggestions block, numbered cards are episodes.
        expect(details(`<div data-uia="moreLikeThis-and-episodes">${card('1', 'Eins')}${card('2', 'Zwei')}</div>${card(null, 'Vorschlag', 'titleCard--container more-like-this-item')}`)).toEqual([
            'Eins',
            'Zwei',
        ]);
    });

    it('without episode numbers, leaves out the suggestions block', () => {
        expect(details(`${card(null, 'Film')}<div class="moreLikeThis--container">${card(null, 'Vorschlag', 'titleCard--container more-like-this-item')}</div>`)).toEqual(['Film']);
    });
});

describe('runCatalogCommand', () => {
    it('plays through an existing link', async () => {
        document.body.innerHTML = BROWSE;
        const click = vi.fn((e: Event) => e.preventDefault());
        document.querySelector('a[href^="/watch/80057281"]')!.addEventListener('click', click);
        expect(await runCatalogCommand(document, { type: 'catalog.play', id: '80057281' })).toEqual({ ok: true });
        expect(click).toHaveBeenCalled();
    });

    it('picks profiles and episodes, closes the details', async () => {
        document.body.innerHTML =
            '<a data-uia="profile-link" href="#">A</a><a data-uia="profile-link" href="#">B</a>' + MODAL;
        const clicked: string[] = [];
        document.addEventListener('click', (e) => {
            e.preventDefault();
            clicked.push((e.target as HTMLElement).textContent!.replace(/\s+/g, '').slice(0, 12));
        });
        await runCatalogCommand(document, { type: 'catalog.profile', index: 1 });
        await runCatalogCommand(document, { type: 'catalog.episode', index: 1 });
        await runCatalogCommand(document, { type: 'catalog.back' });
        expect(clicked).toEqual(['B', '2Lügen', '']);
        expect((await runCatalogCommand(document, { type: 'catalog.episode', index: 9 })).ok).toBe(false);
    });

    it('returns the catalog as data', async () => {
        document.body.innerHTML = BROWSE;
        const r = await runCatalogCommand(document, { type: 'catalog.get', offset: 0, limit: 1 });
        expect(r.ok).toBe(true);
        expect((r.data as any).rows).toHaveLength(1);
    });
});

describe('diagnose', () => {
    it('summarizes what the scraper sees', () => {
        document.body.innerHTML = BROWSE;
        const d = diagnose(document) as any;
        expect(d.page).toBe('browse');
        expect(d.rows).toEqual(['Weiterschauen für Marcus: 2 – Dark, Stranger Things', 'Derzeit beliebt: 1 – Squid Game']);
        expect(d.titleLinks).toBeGreaterThan(3);
        expect(d.sampleLinks.some((l: any) => l.path.includes('div.lolomoRow'))).toBe(true);
    });
});
