// Every Netflix DOM hook lives here. Prefer language-independent `data-uia`
// attributes and links over styling classes, which Netflix renames often.
// When Netflix changes its markup, this is the file to update.

export const SEL = {
    skip: [
        '[data-uia="player-skip-intro"]',
        '[data-uia="player-skip-recap"]',
        '[data-uia="player-skip-credits"]',
        '[data-uia="player-skip-preplay"]',
    ],
    next: [
        '[data-uia="next-episode-seamless-button"]',
        '[data-uia="next-episode-seamless-button-draining"]',
        '[data-uia="control-next"]',
    ],
    back: ['[data-uia="control-nav-back"]'],
    videoTitle: '[data-uia="video-title"]',
    profileGate: ['.list-profiles', '.profiles-gate-container', '[data-uia="profile-choices-page"]', '[data-uia="profile-link"]'],
    /** Menus in the page header also contain profile links (profile switcher); those are not the gate. */
    headerMenus: 'header, nav, [role="menu"], .account-menu, .account-dropdown-button, .sub-menu, .pinning-header',
    video: 'video',

    // ---- catalog (browse, search, title details) ----
    /** Links to titles; the id is taken from the href. */
    titleLinks: 'a[href*="/watch/"], a[href*="/title/"], a[href*="jbv="]',
    /** A card around a title link (holds image, progress). */
    card: ['.title-card-container', '.title-card', '[data-uia="title-card"]', '.slider-item', '[data-uia*="card"]'],
    /** A row ("Continue watching", "Trending now" …). */
    row: ['[data-list-context]', '.lolomoRow', '[data-uia="row"]', '[data-uia*="lolomo-row"]', 'section'],
    rowTitle: ['.row-header-title', '[data-uia="row-title"]', 'h2', 'h3'],
    cardName: ['.fallback-text', '[data-uia="title-card-name"]'],
    progress: ['[class*="progress-completed"]', 'progress'],
    /** Hero banner on top of browse pages ("billboard", its trailer plays automatically). */
    billboard: ['.billboard-row', '[data-uia="billboard"]', '.billboard'],
    billboardLogo: ['[data-uia="billboard-title"] img', '.billboard-title img', 'img.title-logo'],
    billboardSynopsis: ['[data-uia="billboard-synopsis"]', '.billboard-description .synopsis', '.billboard-description', '.synopsis'],
    billboardImage: ['.hero-image-wrapper img', 'img.hero', '.static-image', '[data-uia="billboard-image"] img'],
    /** Links that carry the billboard's title id (play link, "more info"). */
    billboardLinks: 'a[href*="/watch/"], a[href*="/title/"], a[href*="jbv="], [data-videoid]',
    profileLink: ['[data-uia="profile-link"]', '.profile-link'],
    profileName: ['.profile-name', '[data-uia="profile-name"]'],
    profileImage: ['.profile-icon', '[data-uia="profile-icon"]', 'img'],
    /** Title details dialog ("jawbone"), opened via ?jbv=<id>. */
    detail: [
        '[data-uia="modal-motion-container-DETAIL_MODAL"]',
        '.previewModal--container.detail-modal',
        '.previewModal--container',
        '[role="dialog"]',
    ],
    detailTitle: ['[data-uia="previewModal--player-titleTreatment-logo"]', '.previewModal--player-titleTreatment-logo', 'h3', 'h2'],
    detailSynopsis: ['[data-uia="previewModal--synopsis"]', '.preview-modal-synopsis', '.previewModal--text p', 'p'],
    detailPlay: ['[data-uia="play-button"]', 'a[href*="/watch/"]', 'button[data-uia*="play"]'],
    detailClose: ['[data-uia="previewModal-closebtn"]', '.previewModal-close', 'button[aria-label*="lose"]', 'button[aria-label*="chließen"]'],
    episode: ['[data-uia="titleCard--container"]', '.titleCardList--container', '.episode-item'],
    episodeIndex: ['.titleCard-title_index', '[data-uia="titleCard-title_index"]'],
    episodeTitle: ['.titleCard-title_text', '[data-uia="titleCard-title_text"]', 'h3', 'strong'],
    episodeSynopsis: ['.titleCard-synopsis', '[data-uia="titleCard-synopsis"]', 'p'],
    seasonToggle: ['[data-uia="dropdown-toggle"]', '.episodeSelector-dropdown button', 'select'],
    seasonOption: ['[data-uia^="dropdown-menu-item"]', '[role="option"]', '[role="menuitem"]'],
} as const;
