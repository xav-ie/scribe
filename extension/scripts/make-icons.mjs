// Regenerates the extension icons from the logo: just its shell (the spiral
// sound wave), enlarged to fill the icon so it reads at toolbar size, in the
// recording red, which shows on light and dark toolbars. Smaller icons get a thicker
// line. Run with: pnpm icons, inside `nix develop` for the pinned ImageMagick
// that CI compares against
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons');
mkdirSync(out, { recursive: true });

const logo = readFileSync(
  path.join(root, '..', 'assets', 'logo', 'scribe.svg'),
  'utf8',
);
// The shell is the logo's only stroked path.
const shell = /<path d="([^"]+)" fill="none"/.exec(logo)?.[1];
if (!shell) throw new Error('shell path not found in scribe.svg');

// The shell's bounds in logo units, padded by its stroke.
const CENTER = [222.5, 210.9];
const SCALE = 2.6;
const COLOR = '#ff4136';
// Stroke width (logo units, before SCALE) per icon size.
const sizes = { 16: 14, 32: 12, 48: 12, 128: 10 };

const work = mkdtempSync(path.join(tmpdir(), 'scribe-icons-'));
for (const [size, stroke] of Object.entries(sizes)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(256,256) scale(${SCALE}) translate(${-CENTER[0]},${-CENTER[1]})"><path d="${shell}" fill="none" stroke="${COLOR}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  const file = path.join(work, `icon${size}.svg`);
  writeFileSync(file, svg);
  execFileSync('magick', [
    '-background',
    'none',
    '-density',
    '384',
    file,
    '-resize',
    `${size}x${size}`,
    // No timestamps or other metadata, so a rerun produces identical files.
    '-strip',
    '-define',
    'png:exclude-chunks=date,time',
    path.join(out, `icon${size}.png`),
  ]);
}
console.log(`Wrote ${Object.keys(sizes).length} icons to ${out}`);
