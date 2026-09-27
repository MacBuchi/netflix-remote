// Bundles the Chrome extension into extension/dist (load it via chrome://extensions → "Load unpacked").
import { build, context } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

const outdir = 'extension/dist';
const watch = process.argv.includes('--watch');

await rm(outdir, { recursive: true, force: true });
await cp('extension/static', outdir, { recursive: true });

const options = {
    entryPoints: ['background', 'offscreen', 'content', 'page', 'popup'].map((n) => `extension/src/${n}.ts`),
    outdir,
    bundle: true,
    format: 'iife',
    target: 'chrome116',
    sourcemap: 'linked',
    logLevel: 'info',
};

if (watch) {
    await (await context(options)).watch();
} else {
    await build(options);
}
