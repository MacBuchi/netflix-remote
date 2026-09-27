import { defineConfig } from 'vite';

// Phone remote app (PWA). Deployed to GitHub Pages, hence relative asset paths.
export default defineConfig({
    root: 'remote',
    base: './',
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
});
