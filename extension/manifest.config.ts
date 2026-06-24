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
  // The transcription service endpoints the offscreen doc is allowed to POST to.
  // Add your own here; the offscreen fetch is blocked for any host not listed.
  host_permissions: [
    'https://whisperx.lalala.casa/*', // deployed WhisperX service
    'http://localhost:8000/*', // local mock / dev service
    'http://127.0.0.1:8000/*',
  ],
  // Declaring the standalone pages here makes CRXJS bundle them even though
  // they are not "normal" manifest entry points. offscreen.html is created at
  // runtime via chrome.offscreen.createDocument().
  web_accessible_resources: [
    {
      resources: ['src/offscreen.html', 'src/micsetup.html'],
      matches: ['<all_urls>'],
    },
  ],
});
