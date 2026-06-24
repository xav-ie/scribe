import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// CRXJS handles the manifest, HTML entry points and the service worker.
// The offscreen + micsetup pages are picked up because they are declared as
// web_accessible_resources in the manifest (see manifest.config.ts).
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
