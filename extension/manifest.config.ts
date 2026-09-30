import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Meeting Capture',
  version: pkg.version,
  description: pkg.description,
  icons: {
    16: 'public/icons/icon16.png',
    32: 'public/icons/icon32.png',
    48: 'public/icons/icon48.png',
    128: 'public/icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup.html',
    default_title: 'Meeting Capture',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  permissions: ['tabCapture', 'offscreen', 'storage', 'activeTab', 'tabs'],
  // Streaming service endpoints: the WebSocket the offscreen doc streams PCM to,
  // and the HTTP API the worker posts session records to. A host must be listed
  // here or the connection is blocked.
  host_permissions: [
    'wss://scribe.lalala.casa/*', // deployed streaming ASR service
    'https://scribe.lalala.casa/*', // its session API: records posted at stop
    'ws://localhost:8000/*', // local dev service
    'ws://127.0.0.1:8000/*',
    'http://localhost:8000/*',
    'http://127.0.0.1:8000/*',
  ],
  // Active-speaker scraper, injected into supported meeting clients. It reports
  // speaker changes to the background worker, which joins them with the streamed
  // word timestamps (see src/speaker/, src/transcript.ts).
  content_scripts: [
    {
      matches: ['https://meet.google.com/*', 'https://*.zoom.us/*'],
      js: ['src/speaker/index.ts'],
      run_at: 'document_idle',
    },
  ],
  // Declaring the standalone pages here makes CRXJS bundle them even though they
  // are not "normal" manifest entry points. offscreen.html is created at runtime
  // via chrome.offscreen.createDocument().
  web_accessible_resources: [
    {
      resources: ['src/offscreen.html', 'src/micsetup.html'],
      matches: ['<all_urls>'],
    },
  ],
});
