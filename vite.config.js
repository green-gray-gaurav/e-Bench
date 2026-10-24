import { defineConfig } from 'vite';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  plugins: [{ name: 'pdf-assets', closeBundle() {
    mkdirSync('dist/pdf-assets', { recursive: true });
    for (const folder of ['cmaps', 'standard_fonts', 'wasm']) cpSync(`node_modules/pdfjs-dist/${folder}`, `dist/pdf-assets/${folder}`, { recursive: true });
  } }],
});
