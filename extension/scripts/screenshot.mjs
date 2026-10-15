// The README's images: the real popup, built from this source with a sample
// transcript, open over a mock Google Meet call (assets/screenshot.png), and a
// diagram of how the extension and server connect (assets/how-it-works.png),
// in the extension's theme and fonts. Run with: pnpm screenshot   (builds
// first; needs Chrome or Chromium, like pnpm a11y)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, servePreview } from './preview.mjs';

const assets = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
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
<html><head><meta charset="utf-8"><style>
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

const fonts = `
  @font-face { font-family: 'Inter'; font-weight: 100 900; src: url('/fonts/inter-latin-variable.woff2'); }
  @font-face { font-family: 'Maple Mono'; font-weight: 400; src: url('/fonts/maple-mono-latin-400.woff2'); }`;

// How the parts connect, left to right: the meeting, the extension, the
// server, and what reads its sessions.
const card = (title, sub, lines, cls = '') => `
  <div class="card ${cls}">
    <h2>${title}</h2>
    <div class="sub">${sub}</div>
    ${lines.map((l) => `<p>${l}</p>`).join('')}
  </div>`;
const link = (forward, back) => `
  <div class="link">
    <div class="label">${forward}</div>
    <div class="arrow right"></div>
    ${back ? `<div class="arrow left"></div><div class="label">${back}</div>` : ''}
  </div>`;
const diagram = `<!doctype html>
<html><head><meta charset="utf-8"><style>${fonts}
  body { margin: 0; background: #33200d; color: #fbefe6; font-family: 'Inter', sans-serif; }
  .row { width: 1400px; padding: 44px 40px; box-sizing: border-box; display: flex; align-items: stretch; }
  .card { flex: 0 0 226px; box-sizing: border-box; background: #241608; border: 2px solid #c9936b; border-radius: 14px; padding: 18px 20px; }
  .card.server { border: 3px solid #ff4136; }
  h2 { margin: 0; font-size: 21px; }
  .sub { font: 14px 'Maple Mono', monospace; color: #ecd0b8; margin: 4px 0 12px; }
  p { margin: 0 0 6px; font-size: 16px; line-height: 1.4; color: #ecd0b8; }
  .link { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 6px; padding: 0 12px; }
  .label { text-align: center; font-size: 15px; color: #fbefe6; }
  .arrow { height: 2px; background: #ffc4a8; position: relative; }
  .arrow::after { content: ''; position: absolute; top: -6px; border: 7px solid transparent; }
  .arrow.right::after { right: -2px; border-left: 11px solid #ffc4a8; border-right: 0; }
  .arrow.left::after { left: -2px; border-right: 11px solid #ffc4a8; border-left: 0; }
</style></head><body><div class="row">
  ${card('Meeting tab', 'Google Meet · Zoom', ['The call you are in, with its active speaker indicator.'])}
  ${link('audio and<br>active speaker')}
  ${card('Extension', 'extension/', ['Streams the tab and your mic, and labels each word with the speaker shown at that moment.'])}
  ${link('audio over<br>a WebSocket', 'words with<br>timestamps')}
  ${card('scribe server', 'server/', ['NVIDIA Parakeet streaming recognition on your GPU. Keeps every session.'], 'server')}
  ${link('HTTP, MCP')}
  ${card('Your tools', 'any client', ['Web UI to replay and follow live', 'MCP for AI agents', 'OpenAI-compatible transcription API'])}
</div></body></html>`;

const preview = await servePreview(() => ({ rec: recording }), {
  '/hero.html': hero,
  '/diagram.html': diagram,
});
const browser = await launchChrome();
try {
  const shots = [
    ['hero.html', 'screenshot.png', 1280, 760],
    ['diagram.html', 'how-it-works.png', 1400, 300],
  ];
  for (const [url, file, width, height] of shots) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto(`${preview.url}/${url}`, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(assets, file), fullPage: true });
    console.log(`Wrote assets/${file}`);
  }
} finally {
  await browser.close();
  preview.close();
}
