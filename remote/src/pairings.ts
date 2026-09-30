// Paired PCs, remembered on the phone so it reconnects without scanning again.

import { parsePairingHash, type Pairing } from '../../shared/protocol';

const KEY = 'nfr.pairings';
const ACTIVE = 'nfr.active';

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function write(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* private mode or storage full: pairing lasts for this visit only */
    }
}

/**
 * The same PC as far as the user can tell: same peer id, or same name on the same browser and system.
 * Reinstalling the extension (new folder, other profile) gives the PC a new peer id but not a new name,
 * and pairings from before version 2.2.13 carry no browser/system, so for them the name decides.
 */
export function samePc(a: Pairing, b: Pairing): boolean {
    return a.peerId === b.peerId || (a.name === b.name && (!a.device || !b.device || a.device === b.device));
}

/** Newest first; of several entries for the same PC only the newest stays. */
export function dedupe(list: Pairing[]): Pairing[] {
    const kept: Pairing[] = [];
    for (const p of list) if (!kept.some((k) => samePc(k, p))) kept.push(p);
    return kept;
}

export function loadPairings(): Pairing[] {
    const raw = read<Pairing[]>(KEY, []);
    const list = Array.isArray(raw) ? raw.filter((p) => p && p.peerId && p.key) : [];
    const clean = dedupe(list);
    if (clean.length !== list.length) {
        write(KEY, clean);
        const active = activePeerId();
        if (active && !clean.some((p) => p.peerId === active)) write(ACTIVE, clean[0]?.peerId ?? null);
    }
    return clean;
}

export function activePeerId(): string | null {
    return read<string | null>(ACTIVE, null);
}

export function setActive(peerId: string) {
    write(ACTIVE, peerId);
}

/** Adds a pairing, replacing older ones of the same PC (see samePc), and makes it active. */
export function savePairing(p: Pairing): Pairing[] {
    const list = loadPairings().filter((x) => !samePc(x, p));
    list.unshift(p);
    write(KEY, list);
    setActive(p.peerId);
    return list;
}

export function removePairing(peerId: string): Pairing[] {
    const list = loadPairings().filter((x) => x.peerId !== peerId);
    write(KEY, list);
    if (activePeerId() === peerId) write(ACTIVE, list[0]?.peerId ?? null);
    return list;
}

/** "Chrome · macOS · gekoppelt am 30.09.2026"; empty for pairings from before these details. */
export function pairingDetails(p: Pairing): string {
    const date = p.pairedAt ? `gekoppelt am ${new Date(p.pairedAt).toLocaleDateString('de-DE')}` : '';
    return [p.device, date].filter(Boolean).join(' · ');
}

/** What the PC picker shows: the name, plus browser/system or date where names repeat. */
export function pairingLabel(p: Pairing, all: Pairing[]): string {
    if (all.filter((x) => x.name === p.name).length < 2) return p.name;
    const extra = p.device ?? (p.pairedAt ? new Date(p.pairedAt).toLocaleDateString('de-DE') : '');
    return extra ? `${p.name} (${extra})` : p.name;
}

/** Picks up a pairing from the QR link (#pc=…&k=…) and removes the secret from the address bar. */
export function consumePairingFromUrl(): Pairing | null {
    const p = parsePairingHash(location.hash);
    if (!p) return null;
    p.pairedAt = Date.now();
    savePairing(p);
    history.replaceState(null, '', location.pathname + location.search);
    return p;
}
