// Accessibility check of the built popup and settings pages: each page is
// loaded from dist/ with a stubbed `chrome` API in the states worth checking
// (idle, recording with a transcript, errors and warnings showing, the access
// and microphone panels), and axe-core reports any WCAG 2.2 A/AA violation,
// color contrast included. Run with: pnpm a11y   (builds first; needs Chrome or
// Chromium, found on PATH or through CHROME_PATH)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launch } from 'puppeteer-core';
import { findChrome, servePreview } from './preview.mjs';

const axe = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

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

let current = states[0];
const preview = await servePreview(() => current);

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
    await page.goto(`${preview.url}/src/${state.page}.html`, {
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
  preview.close();
}
if (failures > 0) {
  console.error(`${failures} accessibility violation(s)`);
  process.exitCode = 1;
}
