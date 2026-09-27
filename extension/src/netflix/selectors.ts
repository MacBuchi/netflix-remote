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
    profileGate: ['[data-uia="profile-link"]', '.list-profiles'],
    video: 'video',
} as const;
