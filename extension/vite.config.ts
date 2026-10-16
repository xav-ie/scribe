import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

// CRXJS bundles the manifest entry points (service worker + action popup).
// The offscreen page is NOT a manifest entry point, so it must be declared as
// an explicit Rollup input or its <script> would ship pointing at raw .ts
// (which the browser can't run). Keys mirror the source path so the
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
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
