// The README's images: the real popup, built from this source with a sample
// transcript, open over a mock Google Meet call (assets/screenshot.png), and a
// diagram of how the extension and server connect (assets/how-it-works.png),
// in the extension's theme and fonts. Run with: pnpm screenshot   (builds
// first; needs Chrome or Chromium, like pnpm a11y)
import { readFileSync } from 'node:fs';
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

// How the parts connect, left to right, drawn rather than described: the
// call, the extension's popup, the server, and what reads its sessions.
// The snail alone (assets/logo/mark.svg) and the palette, both generated from
// the same sources as everything else by scripts/assets.mjs.
const mark = `url("data:image/svg+xml,${encodeURIComponent(
  readFileSync(path.join(assets, 'logo', 'mark.svg'), 'utf8'),
)}")`;
const c = JSON.parse(
  readFileSync(path.join(assets, 'palette.json'), 'utf8'),
).dark;
const tile = (color, speaking) => `
  <div class="tile${speaking ? ' speaking' : ''}"><span style="background:${color}"></span>
  ${speaking ? '<i></i><i></i><i></i><i></i>' : ''}</div>`;
const line = (color, widths) => `
  <div class="line"><b style="background:${color}"></b>${widths
    .map((w) => `<em style="width:${w}px"></em>`)
    .join('')}</div>`;
const icon = (svg, label) => `
  <div class="tool">${svg}<span>${label}</span></div>`;
const browserIcon = `<svg viewBox="0 0 48 48"><rect x="4" y="8" width="40" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M4 17h40" stroke="currentColor" stroke-width="3"/><circle cx="10" cy="12.5" r="1.8" fill="currentColor"/><circle cx="16" cy="12.5" r="1.8" fill="currentColor"/><path d="M14 31l6-6 5 4 9-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const agentIcon = `<svg viewBox="0 0 48 48"><rect x="9" y="14" width="30" height="24" rx="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 14V7" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="6" r="2.5" fill="currentColor"/><circle cx="18" cy="25" r="3" fill="currentColor"/><circle cx="30" cy="25" r="3" fill="currentColor"/><path d="M19 32h10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
const apiIcon = `<svg viewBox="0 0 48 48"><path d="M17 8c-5 0-6 3-6 7v4c0 3-2 5-5 5 3 0 5 2 5 5v4c0 4 1 7 6 7M31 8c5 0 6 3 6 7v4c0 3 2 5 5 5-3 0-5 2-5 5v4c0 4-1 7-6 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const wave = [10, 22, 36, 18, 44, 28, 52, 30, 40, 16, 34, 24, 12]
  .map((h) => `<i style="height:${h}px"></i>`)
  .join('');
const diagram = `<!doctype html>
<html><head><meta charset="utf-8"><style>${fonts}
  body { margin: 0; background: ${c.bg}; color: ${c.text}; font-family: 'Inter', sans-serif; }
  .row { width: 1400px; padding: 56px 48px 52px; box-sizing: border-box; display: flex; align-items: center; }
  .step { flex: 0 0 250px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .art { width: 250px; height: 250px; box-sizing: border-box; border-radius: 22px; background: ${c.surface}; border: 2px solid ${c.line}; display: flex; align-items: center; justify-content: center; position: relative; }
  .step h2 { margin: 0; font-size: 24px; font-weight: 700; }
  .step p { margin: -10px 0 0; font-size: 16px; color: ${c.muted}; text-align: center; }
  /* the call */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 196px; }
  .tile { height: 92px; border-radius: 12px; background: #3c4043; display: grid; place-items: center; position: relative; }
  .tile span { width: 40px; height: 40px; border-radius: 50%; }
  .tile.speaking { outline: 3px solid #8ab4f8; }
  .tile i { position: absolute; bottom: 10px; width: 4px; border-radius: 2px; background: #8ab4f8; }
  .tile i:nth-of-type(1) { right: 28px; height: 8px; } .tile i:nth-of-type(2) { right: 22px; height: 16px; }
  .tile i:nth-of-type(3) { right: 16px; height: 11px; } .tile i:nth-of-type(4) { right: 10px; height: 6px; }
  /* the popup */
  .popup { width: 190px; display: flex; flex-direction: column; gap: 14px; }
  .bar { display: flex; align-items: center; gap: 8px; }
  .bar .mark { width: 42px; height: 29px; background: ${mark} no-repeat center / contain; }
  .bar .rec { margin-left: auto; padding: 3px 9px; border-radius: 99px; background: ${c.button}; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .line b { width: 62px; height: 9px; border-radius: 5px; flex-basis: 100%; max-width: 62px; }
  .line em { height: 8px; border-radius: 4px; background: ${c.line}; }
  /* the server */
  .server { border: 3px solid ${c.rec}; flex-direction: column; gap: 14px; }
  .server .snail { width: 172px; height: 120px; background: ${mark} no-repeat center / contain; }
  .wave { display: flex; align-items: center; gap: 5px; height: 56px; }
  .wave i { width: 6px; border-radius: 3px; background: ${c.rec}; opacity: .85; }
  /* the tools */
  .tools { flex-direction: column; gap: 14px; align-items: stretch; padding: 0 26px; }
  .tool { display: flex; align-items: center; gap: 14px; color: ${c.link}; font-size: 18px; font-weight: 600; }
  .tool svg { width: 44px; height: 44px; flex: none; }
  .tool span { color: ${c.text}; }
  /* arrows between steps */
  .link { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 0 14px; margin-top: -60px; }
  .label { text-align: center; font-size: 15px; font-weight: 600; color: ${c.link}; }
  .arrow { height: 0; border-top: 3px dashed ${c.link}; position: relative; }
  .arrow::after { content: ''; position: absolute; top: -9px; border: 8px solid transparent; }
  .arrow.right::after { right: -4px; border-left: 13px solid ${c.link}; border-right: 0; }
  .arrow.left::after { left: -4px; border-right: 13px solid ${c.link}; border-left: 0; }
</style></head><body><div class="row">
  <div class="step">
    <div class="art"><div class="grid">${tile('#8e5cd9', true)}${tile('#1f8f6f')}${tile('#c26a1e')}${tile('#3d6fd6')}</div></div>
    <h2>Your call</h2><p>Google Meet or Zoom</p>
  </div>
  <div class="link"><div class="label">audio +<br>speaker</div><div class="arrow right"></div></div>
  <div class="step">
    <div class="art"><div class="popup">
      <div class="bar"><span class="mark"></span><span class="rec">REC</span></div>
      ${line('#c9b3f5', [70, 96])}${line('#a7e8cf', [110, 48])}${line('#f8c99e', [84, 74])}
    </div></div>
    <h2>Extension</h2><p>names every speaker</p>
  </div>
  <div class="link">
    <div class="label">audio</div><div class="arrow right"></div>
    <div class="arrow left"></div><div class="label">words, live</div>
  </div>
  <div class="step">
    <div class="art server"><div class="snail"></div><div class="wave">${wave}</div></div>
    <h2>scribe server</h2><p>on your own GPU</p>
  </div>
  <div class="link"><div class="label">every meeting</div><div class="arrow right"></div></div>
  <div class="step">
    <div class="art tools">
      ${icon(browserIcon, 'Web UI')}${icon(agentIcon, 'AI agents')}${icon(apiIcon, 'OpenAI API')}
    </div>
    <h2>Your tools</h2><p>replay, search, reuse</p>
  </div>
</div></body></html>`;

const preview = await servePreview(() => ({ rec: recording }), {
  '/hero.html': hero,
  '/diagram.html': diagram,
});
const browser = await launchChrome();
try {
  const shots = [
    ['hero.html', 'screenshot.png', 1280, 760],
    ['diagram.html', 'how-it-works.png', 1400, 400],
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
