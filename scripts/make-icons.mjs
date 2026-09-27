// Renders the app/extension icon from SVG into the PNG sizes Chrome and Android need.
// Run once after changing the design: node scripts/make-icons.mjs
import { chromium } from 'playwright';

const svg = (padding) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${padding ? 0 : 112}" fill="#141414"/>
  <g transform="translate(256 256) scale(${padding ? 0.72 : 1}) translate(-256 -256)">
    <rect x="156" y="56" width="200" height="400" rx="60" fill="#e50914"/>
    <circle cx="256" cy="176" r="62" fill="#141414"/>
    <path d="M236 146 L286 176 L236 206 Z" fill="#fff"/>
    <rect x="206" y="290" width="100" height="22" rx="11" fill="#141414"/>
    <rect x="206" y="340" width="100" height="22" rx="11" fill="#141414"/>
    <rect x="206" y="390" width="100" height="22" rx="11" fill="#141414"/>
  </g>
</svg>`;

const targets = [
    ...[16, 32, 48, 128].map((s) => ({ size: s, file: `extension/static/icons/icon-${s}.png` })),
    { size: 192, file: 'remote/public/icon-192.png' },
    { size: 512, file: 'remote/public/icon-512.png' },
    { size: 512, file: 'remote/public/icon-maskable-512.png', maskable: true },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(`<style>*{margin:0}svg{display:block;width:${t.size}px;height:${t.size}px}</style>${svg(t.maskable)}`);
    await page.locator('svg').screenshot({ path: t.file, omitBackground: true });
    console.log('wrote', t.file);
}
await browser.close();
