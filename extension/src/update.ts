// Updates for the unpacked extension from GitHub Releases. Chrome only auto-updates store extensions,
// and an extension cannot rewrite its own files, so:
//  - it asks GitHub about twice a day for the latest release and shows it in the popup, as a badge and
//    on the phone;
//  - the update script shipped in the folder (update.command / update.cmd) swaps in the new files;
//  - the extension notices its manifest on disk carries another version and reloads itself.

import type { ExtensionUpdate } from '../../shared/protocol';

export const REPO = 'MacBuchi/netflix-remote';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 12 * 3600_000;

export interface Release {
    version: string;
    /** Release page with notes. */
    page: string;
    /** The extension ZIP, if the release has one. */
    zip: string | null;
}

interface Stored {
    checkedAt: number;
    release: Release | null;
}

/** -1, 0 or 1 like a sort comparator; "2.10.0" is newer than "2.9.3". */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return Math.sign(d);
    }
    return 0;
}

/** The release from GitHub's "latest release" answer; null for anything else. */
export function parseRelease(json: any): Release | null {
    const version = typeof json?.tag_name === 'string' ? json.tag_name.replace(/^v/, '') : '';
    if (!/^\d+(\.\d+){0,3}$/.test(version)) return null;
    const assets: any[] = Array.isArray(json.assets) ? json.assets : [];
    const zip = assets.map((a) => a?.browser_download_url).find((u) => typeof u === 'string' && /^https:\/\/github\.com\/.+\.zip$/.test(u));
    const page = typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : `https://github.com/${REPO}/releases/latest`;
    return { version, page, zip: zip ?? null };
}

export const installedVersion = () => chrome.runtime.getManifest().version;

/** Only unpacked installs update this way; store installs are updated by Chrome. */
async function unpacked(): Promise<boolean> {
    try {
        return (await chrome.management.getSelf()).installType === 'development';
    } catch {
        return true;
    }
}

async function stored(): Promise<Stored | undefined> {
    return ((await chrome.storage.local.get('update')) as { update?: Stored }).update;
}

/** Asks GitHub for the latest release, at most every 12 hours unless forced. */
export async function checkForUpdate(force = false): Promise<ExtensionUpdate | null> {
    if (!(await unpacked())) return null;
    const last = await stored();
    if (force || !last || Date.now() - last.checkedAt > CHECK_EVERY) {
        try {
            const res = await fetch(LATEST_API, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
            const release = res.ok ? parseRelease(await res.json()) : null;
            // Keep the last known release when GitHub is unreachable or rate-limited.
            await chrome.storage.local.set({ update: { checkedAt: Date.now(), release: release ?? last?.release ?? null } satisfies Stored });
        } catch {
            /* offline: try again with the next check */
        }
    }
    const info = await updateInfo();
    await chrome.action.setBadgeText({ text: info ? 'Neu' : '' });
    if (info) await chrome.action.setBadgeBackgroundColor({ color: '#6c4dff' });
    return info;
}

/** What the popup and the phone show: only when a newer release exists. */
export async function updateInfo(): Promise<ExtensionUpdate | null> {
    const release = (await stored())?.release;
    const current = installedVersion();
    if (!release || compareVersions(release.version, current) <= 0) return null;
    return { current, latest: release.version, page: release.page, zip: release.zip };
}

/**
 * Unpacked extensions serve their files straight from the folder, so the manifest on disk tells
 * whether the update script (or a hand-unpacked ZIP) replaced them. Then reload to run the new code.
 */
export async function reloadIfReplaced(): Promise<boolean> {
    try {
        const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
        const onDisk = String((await res.json())?.version ?? '');
        if (!onDisk || onDisk === installedVersion()) return false;
    } catch {
        return false; // mid-copy: the next check sees the finished files
    }
    chrome.runtime.reload();
    return true;
}
