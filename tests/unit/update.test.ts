import { describe, expect, it } from 'vitest';
import { compareVersions, parseRelease } from '../../extension/src/update';

describe('compareVersions', () => {
    it('compares numerically, part by part', () => {
        expect(compareVersions('2.2.12', '2.2.11')).toBe(1);
        expect(compareVersions('2.10.0', '2.9.3')).toBe(1);
        expect(compareVersions('2.2', '2.2.0')).toBe(0);
        expect(compareVersions('2.2.11', '3.0.0')).toBe(-1);
    });
});

describe('parseRelease', () => {
    const release = {
        tag_name: 'v2.2.12',
        html_url: 'https://github.com/MacBuchi/netflix-remote/releases/tag/v2.2.12',
        assets: [
            { browser_download_url: 'https://github.com/MacBuchi/netflix-remote/releases/download/v2.2.12/notes.txt' },
            { browser_download_url: 'https://github.com/MacBuchi/netflix-remote/releases/download/v2.2.12/couch-remote-v2.2.12.zip' },
        ],
    };

    it('reads version, release page and the ZIP', () => {
        expect(parseRelease(release)).toEqual({
            version: '2.2.12',
            page: 'https://github.com/MacBuchi/netflix-remote/releases/tag/v2.2.12',
            zip: 'https://github.com/MacBuchi/netflix-remote/releases/download/v2.2.12/couch-remote-v2.2.12.zip',
        });
    });

    it('only links to GitHub and rejects answers without a version', () => {
        expect(parseRelease({ ...release, html_url: 'https://evil.example/', assets: [{ browser_download_url: 'https://evil.example/x.zip' }] })).toEqual({
            version: '2.2.12',
            page: 'https://github.com/MacBuchi/netflix-remote/releases/latest',
            zip: null,
        });
        expect(parseRelease({ message: 'API rate limit exceeded' })).toBeNull();
        expect(parseRelease(null)).toBeNull();
    });
});
