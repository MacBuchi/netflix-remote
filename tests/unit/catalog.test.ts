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

    it('reads the title details with episodes and keeps them out of the rows', () => {
        history.replaceState(null, '', '/browse?jbv=80100172');
        document.body.innerHTML = BROWSE + MODAL;
        const c = readCatalog(document);
        expect(c.page).toBe('title');
        expect(c.detail).toMatchObject({
            id: '80100172',
            title: 'Dark',
            synopsis: 'Ein Kind verschwindet.',
            seasons: ['Staffel 1'],
            season: 0,
        });
        expect(c.detail!.episodes.map((e) => `${e.label}. ${e.title}`)).toEqual(['1. Geheimnisse', '2. Lügen']);
        expect(c.detail!.episodes[0].synopsis).toBe('Mikkel verschwindet.');
        expect(c.rows.flatMap((r) => r.items).some((i) => i.name === 'Abspielen')).toBe(false);
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
        expect(d.rows).toEqual(['Weiterschauen für Marcus: 2', 'Derzeit beliebt: 1']);
        expect(d.titleLinks).toBeGreaterThan(3);
        expect(d.sampleLinks.some((l: any) => l.path.includes('div.lolomoRow'))).toBe(true);
    });
});
