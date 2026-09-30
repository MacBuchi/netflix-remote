// Browser and system of this PC for the pairing link ("Chrome · macOS"), so the phone can tell
// PCs of the same name apart.

const BRANDS: [RegExp, string][] = [
    [/opera|OPR\//i, 'Opera'],
    [/edg/i, 'Edge'],
    [/brave/i, 'Brave'],
    [/vivaldi/i, 'Vivaldi'],
    [/chrome/i, 'Chrome'],
];

const SYSTEMS: [RegExp, string][] = [
    [/mac/i, 'macOS'],
    [/win/i, 'Windows'],
    [/cros|chrome os/i, 'ChromeOS'],
    [/linux|x11/i, 'Linux'],
];

const pick = (list: [RegExp, string][], text: string) => list.find(([re]) => re.test(text))?.[1];

export function describeDevice(nav: Navigator = navigator): string {
    const data = (nav as Navigator & { userAgentData?: { brands?: { brand: string }[]; platform?: string } }).userAgentData;
    // Opera and others add their own brand next to "Chromium"; the user agent string often hides them.
    const brands = data?.brands?.map((b) => b.brand).join(' ') ?? '';
    const browser = pick(BRANDS, brands) ?? pick(BRANDS, nav.userAgent) ?? 'Chrome';
    const system = pick(SYSTEMS, data?.platform ?? '') ?? pick(SYSTEMS, nav.userAgent);
    return system ? `${browser} · ${system}` : browser;
}
