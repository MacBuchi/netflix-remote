// Messages between the extension's own parts:
//   offscreen (WebRTC) <-> service worker (tabs, windows) <-> content script <-> page script (MAIN world)

import type { CatalogCommand, Command, CommandResult, PageKind, PlayerCommand, PlayerState, RemoteState } from '../../shared/protocol';

export interface Config {
    /** Stable PeerJS id of this browser; phones reconnect to it. */
    peerId: string;
    /** Shared secret from the QR code; phones must present it before sending commands. */
    key: string;
    pcName: string;
    /** PeerJS broker URL, empty for the public PeerJS cloud. */
    broker: string;
    /** MQTT relay for networks that block direct connections, empty for the default public relay. */
    relay: string;
    /** Where the phone app is hosted; the QR code links there. */
    remoteUrl: string;
}

export const DEFAULT_REMOTE_URL = 'https://macbuchi.github.io/netflix-remote/';

export interface TabState {
    page: PageKind;
    location: string;
    player: PlayerState | null;
}

export type SwMsg =
    | { target: 'sw'; type: 'getConfig' }
    /** Popup: newer release on GitHub (checked now), null when up to date. */
    | { target: 'sw'; type: 'getUpdate' }
    | { target: 'sw'; type: 'updateConfig'; patch: Partial<Pick<Config, 'pcName' | 'broker' | 'relay' | 'remoteUrl'>> }
    | { target: 'sw'; type: 'resetPairing' }
    | { target: 'sw'; type: 'command'; cmd: Command }
    | { target: 'sw'; type: 'clients'; count: number }
    | { target: 'sw'; type: 'contentHello' }
    | { target: 'sw'; type: 'state'; state: TabState };

export interface OffscreenStatus {
    broker: 'connecting' | 'online' | 'offline';
    relay: 'connecting' | 'online' | 'offline';
    error: string | null;
    devices: string[];
}

export type OffscreenMsg =
    | { target: 'offscreen'; type: 'state'; state: RemoteState }
    | { target: 'offscreen'; type: 'status' };

export type ContentMsg =
    | { target: 'content'; type: 'command'; cmd: PlayerCommand | CatalogCommand }
    | { target: 'content'; type: 'streaming'; on: boolean }
    | { target: 'content'; type: 'pushState' };

// window.postMessage bridge between content script (isolated world) and page script (MAIN world)
export type PageCall = { kind: 'state' } | { kind: 'command'; cmd: PlayerCommand };
export type PageRequest = PageCall & { __nfr: 'req'; id: number };

export interface PageResponse {
    __nfr: 'res';
    id: number;
    result: PlayerState | null | CommandResult;
}
