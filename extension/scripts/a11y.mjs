// Accessibility check of the built popup and settings pages: each page is
// loaded from dist/ with a stubbed `chrome` API in the states worth checking
// (idle, recording with a transcript, errors and warnings showing, the access
// and microphone panels), and axe-core reports any WCAG 2.2 A/AA violation,
// color contrast included. Run with: pnpm a11y   (builds first; needs Chrome or
// Chromium, found on PATH or through CHROME_PATH)
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const axe = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

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

const segments = [
  { speaker: 'Ada Lovelace', start: 0, end: 3, text: 'Shall we start?', at: 0 },
  { speaker: 'Me', start: 3, end: 6, text: 'Yes, the fix landed.', at: 0 },
  { speaker: 'Grace Hopper', start: 6, end: 9, text: 'Then I cut it.', at: 0 },
  { speaker: 'Unknown', start: 9, end: 10, text: 'Sounds good.', at: 0 },
];

// What the stubbed chrome API reports, per checked state.
const states = [
  { page: 'popup', name: 'idle', rec: { status: 'idle' } },
  {
    page: 'popup',
    name: 'recording with transcript, error and warning',
    rec: {
      status: 'recording',
      segments,
      error: 'Cannot reach streaming service at wss://scribe.example.com/ws',
      warning: 'Your microphone is sending pure silence.',
    },
  },
  {
    page: 'popup',
    name: 'raw transcript, no server set',
    wsUrl: '',
    rec: { status: 'recording', rawText: 'hello there general' },
  },
  { page: 'options', name: 'saved server', access: true },
  {
    page: 'options',
    name: 'access needed, error and notice showing',
    access: false,
    reveal: ['#error', '#saved'],
  },
];

function stub({ wsUrl = 'wss://scribe.example.com/ws', rec, access = true }) {
  const recState = { updatedAt: 1, ...rec };
  return `<script>
window.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.0.0', version_name: '0.0.0 a11y' }),
    sendMessage: async () => {},
    openOptionsPage: async () => {},
    getURL: (p) => p,
  },
  storage: {
    sync: { get: async (d) => ({ ...d, wsUrl: ${JSON.stringify(wsUrl)} }), set: async () => {} },
    local: { get: async () => ({ recState: ${JSON.stringify(recState)} }) },
    onChanged: { addListener() {} },
  },
  permissions: { contains: async () => ${access}, request: async () => true },
  tabs: { create() {} },
};
</script>`;
}

let current = states[0];
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = path.join(dist, path.normalize(url.pathname));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body = readFileSync(file);
    const type = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    }[path.extname(file)];
    if (type === 'text/html') {
      body = body.toString().replace('<head>', `<head>${stub(current)}`);
    }
    res.writeHead(200, type ? { 'Content-Type': type } : {}).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const browser = await launch({
  executablePath: findChrome(),
  args: ['--no-sandbox'],
});
let failures = 0;
try {
  for (const state of states) {
    current = state;
    const page = await browser.newPage();
    await page.setViewport({
      width: state.page === 'popup' ? 348 : 640,
      height: 700,
    });
    await page.goto(`http://127.0.0.1:${port}/src/${state.page}.html`, {
      waitUntil: 'networkidle0',
    });
    await page.evaluate((selectors) => {
      for (const s of selectors) {
        const el = document.querySelector(s);
        el.textContent ||= 'Sample message';
        el.classList.remove('hidden');
      }
    }, state.reveal ?? []);
    await page.evaluate(axe);
    const { violations } = await page.evaluate(() =>
      globalThis.axe.run(document, {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
      }),
    );
    const label = `${state.page}: ${state.name}`;
    if (violations.length === 0) {
      console.log(`ok    ${label}`);
    } else {
      failures += violations.length;
      console.log(`FAIL  ${label}`);
      for (const v of violations) {
        console.log(`  ${v.id}: ${v.help}`);
        for (const node of v.nodes) {
          console.log(
            `    ${node.target.join(' ')}: ${node.failureSummary.split('\n').slice(1).join(' ').trim()}`,
          );
        }
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures > 0) {
  console.error(`${failures} accessibility violation(s)`);
  process.exitCode = 1;
}
