// The README's screenshot: the real popup, built from this source with a
// sample transcript, open over a mock Google Meet call. Writes
// ../assets/screenshot.png. Run with: pnpm screenshot   (builds first; needs
// Chrome or Chromium, like pnpm a11y)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';
import { findChrome, servePreview } from './preview.mjs';

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'screenshot.png',
);

const t0 = 1_760_000_000_000;
const segment = (speaker, start, text) => ({
  speaker,
  start,
  end: start + 4,
  text,
  at: t0 + start * 1000,
});
const recording = {
  status: 'recording',
  segments: [
    segment('Ada Lovelace', 0, 'Morning! Should we start with the release?'),
    segment(
      'Grace Hopper',
      4,
      'Yes. The build passed overnight, so we can ship today.',
    ),
    segment(
      'Me',
      10,
      'Great. I will write the notes and tag it after this call.',
    ),
    segment(
      'Alan Turing',
      15,
      'Can we keep the old endpoint for one more week?',
    ),
    segment('Ada Lovelace', 20, 'Sure, it costs us nothing to keep it around.'),
  ],
};

const people = [
  ['Ada Lovelace', '#8e5cd9', true],
  ['Grace Hopper', '#1f8f6f', false],
  ['Alan Turing', '#c26a1e', false],
  ['You', '#3d6fd6', false],
];
const tiles = people
  .map(
    ([name, color, speaking]) => `
    <div class="tile${speaking ? ' speaking' : ''}">
      <div class="avatar" style="background:${color}">${name[0]}</div>
      <div class="name">${name}</div>
    </div>`,
  )
  .join('');

// A browser window: toolbar with the address and the extension's icon, a mock
// Meet call, and the popup open under the icon, as Chrome shows it.
const hero = `<!doctype html>
<html><head><style>
  body { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: #1a1b1e; }
  .window { width: 1280px; height: 760px; position: relative; overflow: hidden; background: #202124; }
  .toolbar { height: 52px; background: #35363a; display: flex; align-items: center; gap: 12px; padding: 0 16px; }
  .url { flex: 1; height: 32px; border-radius: 16px; background: #202124; color: #e8eaed; display: flex; align-items: center; padding: 0 16px; font-size: 14px; }
  .icon { width: 32px; height: 32px; border-radius: 8px; background: #4a4b4f; display: grid; place-items: center; }
  .icon img { width: 22px; height: 22px; }
  .grid { position: absolute; inset: 72px 420px 88px 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .tile { background: #3c4043; border-radius: 12px; position: relative; display: grid; place-items: center; }
  .tile.speaking { outline: 4px solid #8ab4f8; }
  .avatar { width: 96px; height: 96px; border-radius: 50%; color: white; font-size: 44px; display: grid; place-items: center; }
  .name { position: absolute; left: 14px; bottom: 12px; color: white; font-size: 15px; }
  .controls { position: absolute; left: 24px; right: 420px; bottom: 20px; display: flex; justify-content: center; gap: 14px; }
  .controls span { width: 48px; height: 48px; border-radius: 50%; background: #3c4043; }
  .controls span.end { width: 72px; border-radius: 24px; background: #ea4335; }
  iframe { position: absolute; top: 56px; right: 14px; width: 348px; height: 612px; border: 0; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.55); }
</style></head><body>
  <div class="window">
    <div class="toolbar">
      <div class="url">meet.google.com/abc-defg-hij</div>
      <div class="icon"><img src="/icons/icon48.png" alt=""></div>
    </div>
    <div class="grid">${tiles}</div>
    <div class="controls"><span></span><span></span><span></span><span class="end"></span></div>
    <iframe src="/src/popup.html"></iframe>
  </div>
</body></html>`;

const preview = await servePreview(() => ({ rec: recording }), {
  '/hero.html': hero,
});
const browser = await launch({
  executablePath: findChrome(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 2 });
  await page.goto(`${preview.url}/hero.html`, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: out });
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
  preview.close();
}
