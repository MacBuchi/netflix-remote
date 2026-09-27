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

export function loadPairings(): Pairing[] {
    const list = read<Pairing[]>(KEY, []);
    return Array.isArray(list) ? list.filter((p) => p && p.peerId && p.key) : [];
}

export function activePeerId(): string | null {
    return read<string | null>(ACTIVE, null);
}

export function setActive(peerId: string) {
    write(ACTIVE, peerId);
}

/** Adds or updates a pairing (same PC → same peer id) and makes it active. */
export function savePairing(p: Pairing): Pairing[] {
    const list = loadPairings().filter((x) => x.peerId !== p.peerId);
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

/** Picks up a pairing from the QR link (#pc=…&k=…) and removes the secret from the address bar. */
export function consumePairingFromUrl(): Pairing | null {
    const p = parsePairingHash(location.hash);
    if (!p) return null;
    savePairing(p);
    history.replaceState(null, '', location.pathname + location.search);
    return p;
}
