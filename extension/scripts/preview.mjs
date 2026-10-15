// Serves the built extension pages (dist/) with a stubbed `chrome` API, so a
// headless browser can load them in a chosen state. Used by a11y.mjs and
// screenshot.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// CI runners start Chrome slowly now and then: allow a minute, and one retry.
export async function launchChrome() {
  const options = {
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    timeout: 60_000,
  };
  try {
    return await launch(options);
  } catch {
    return launch(options);
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const names = ['chromium', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      if (existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  throw new Error('No Chrome or Chromium found; set CHROME_PATH.');
}

// What the stubbed chrome API reports: the server URL, the recording state the
// popup shows, and whether host access is granted.
function stub({ wsUrl = 'wss://scribe.example.com/ws', rec, access = true }) {
  const recState = { updatedAt: 1, status: 'idle', ...rec };
  return `<script>
window.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.1.0', version_name: '0.1.0' }),
    sendMessage: async () => {},
    openOptionsPage: async () => {},
    getURL: (p) => p,
  },
  storage: {
    sync: { get: async (d) => ({ ...d, withMic: true, wsUrl: ${JSON.stringify(wsUrl)} }), set: async () => {} },
    local: { get: async () => ({ recState: ${JSON.stringify(recState)} }) },
    onChanged: { addListener() {} },
  },
  permissions: { contains: async () => ${access}, request: async () => true },
  tabs: { create() {} },
};
</script>`;
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Serve dist/ on a free port. Every HTML page gets the stub for `state()`'s
 * current value; `pages` adds extra HTML routes. Resolves to { url, close }.
 */
export async function servePreview(state, pages = {}) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pages[pathname]) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(pages[pathname]);
      return;
    }
    // The bundled fonts, for extra pages that want them (/fonts/<file>).
    const base = pathname.startsWith('/fonts/') ? path.join(root, 'src') : dist;
    const file = path.join(base, path.normalize(pathname));
    if (!file.startsWith(base) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    let body = readFileSync(file);
    const type = TYPES[path.extname(file)];
    if (type === 'text/html') {
      body = body.toString().replace('<head>', `<head>${stub(state())}`);
    }
    res.writeHead(200, type ? { 'Content-Type': type } : {}).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}
