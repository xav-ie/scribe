// Regenerates the extension icons from a single drawn glyph using ImageMagick.
// Run with: pnpm icons   (requires `magick` on PATH)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons');
mkdirSync(out, { recursive: true });

const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const r = size - 1;
  const radius = Math.round(size * 0.22);
  execFileSync('magick', [
    '-size',
    `${size}x${size}`,
    'xc:none',
    '-fill',
    '#4f8cff',
    '-draw',
    `roundrectangle 0,0,${r},${r},${radius},${radius}`,
    '-fill',
    '#ff5d5d',
    '-draw',
    `circle ${size / 2},${size / 2} ${size / 2},${size * 0.31}`,
    path.join(out, `icon${size}.png`),
  ]);
}
console.log(`Wrote ${sizes.length} icons to ${out}`);
