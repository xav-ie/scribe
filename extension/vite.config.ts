import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// CRXJS bundles the manifest entry points (service worker + action popup).
// The offscreen and micsetup pages are NOT manifest entry points, so they must
// be declared as explicit Rollup inputs or their <script> would ship pointing at
// raw .ts (which the browser can't run). Keys mirror the source path so the
// built HTML lands at dist/src/<name>.html — matching the paths used in
// chrome.offscreen.createDocument() and chrome.runtime.getURL().
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        'src/offscreen': 'src/offscreen.html',
        'src/micsetup': 'src/micsetup.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
