import { defineConfig } from 'astro/config';

// The upstream pages live under src/astro/pages; keep the generated shells
// separate from public/ until copy-astro-pages.mjs copies the expected files.
export default defineConfig({
    srcDir: './src/astro',
    publicDir: './src/astro/public',
    outDir: './.astro-dist',
    build: { format: 'file' },
});
