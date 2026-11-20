import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works from any path, including a
  // GitHub Pages project site (https://<user>.github.io/<repo>/).
  base: './',
  server: { host: '127.0.0.1', port: 8796, strictPort: true },
  preview: { host: '127.0.0.1', port: 8797, strictPort: true },
  // three.js alone is ~700 kB minified (~200 kB gzipped); one bundle is fine, so don't warn about it
  build: { chunkSizeWarningLimit: 1000 },
});
