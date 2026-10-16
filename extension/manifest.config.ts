import { execFileSync } from 'node:child_process';
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

// Every build says which commit it came from (+dirty for uncommitted changes),
// so a session record or the popup shows exactly what code was running.
// Build-time read of local git metadata, not user input.
// eslint-disable-next-line sonarjs/no-os-command-from-path
const git = (...args: string[]) => execFileSync('git', args).toString().trim();
const BUILD = `${pkg.version} ${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain', '--untracked-files=no') ? '+dirty' : ''} ${new Date().toISOString().slice(0, 16)}Z`;

export default defineManifest({
  manifest_version: 3,
  name: 'Meeting Capture',
  version: pkg.version,
  version_name: BUILD,
  description: pkg.description,
  icons: {
    16: 'public/icons/icon16.png',
    32: 'public/icons/icon32.png',
    48: 'public/icons/icon48.png',
    128: 'public/icons/icon128.png',
  },
  options_ui: {
    page: 'src/options.html',
    open_in_tab: true,
  },
  action: {
    default_popup: 'src/popup.html',
    default_title: 'Meeting Capture',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  // scripting: inject the speaker scraper into a meeting tab opened before the
  // extension was (re)loaded, which Chrome skips.
  permissions: [
    'tabCapture',
    'offscreen',
    'storage',
    'activeTab',
    'tabs',
    'scripting',
    // Finished sessions wait in storage until the server has them; a few long
    // meetings while it's unreachable would pass the 10 MB default quota.
    'unlimitedStorage',
  ],
  // Streaming service endpoints: the WebSocket the offscreen doc streams PCM to,
  // and the HTTP API the worker posts session records to. Local dev is granted
  // at install; the server set on the options page is requested there from
  // optional_host_permissions.
  optional_host_permissions: [
    'wss://*/*',
    'https://*/*',
    'ws://*/*',
    'http://*/*',
  ],
  host_permissions: [
    'ws://localhost:8000/*', // local dev server
    'ws://127.0.0.1:8000/*',
    'http://localhost:8000/*',
    'http://127.0.0.1:8000/*',
    // Meeting clients, so the speaker scraper can be injected into a tab that
    // missed it (the content_scripts entry below already covers these hosts).
    'https://meet.google.com/*',
    'https://*.zoom.us/*',
  ],
  // Active-speaker scraper, injected into supported meeting clients. It reports
  // speaker changes to the background worker, which joins them with the streamed
  // word timestamps (see src/speaker/, src/transcript.ts).
  content_scripts: [
    {
      matches: ['https://meet.google.com/*', 'https://*.zoom.us/*'],
      js: ['src/speaker/index.ts'],
      run_at: 'document_idle',
      // Zoom's web client renders the meeting inside an iframe
      // (iframe#webclient) of its app shell, so the scraper must run there too.
      all_frames: true,
    },
  ],
});
