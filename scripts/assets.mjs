#!/usr/bin/env node
// Generates every derived graphic and color from two sources:
//   assets/logo/snail.svg  the snail, in logo units (512 square), currentColor
//   assets/palette.json    the colors
// It writes:
//   assets/logo/scribe.svg, scribe-light.svg  the logo: the snail on its circle
//   assets/logo/mark.svg                      the snail alone, cropped to its bounds
//   extension/public/icons/icon*.png          the shell, enlarged for the toolbar
//   the marked blocks in extension/src/popup.css and server/ui.html: the palette
//   as CSS variables, and the web UI's favicon and header mark
// Run in `nix develop` (node, and ImageMagick with librsvg for the PNGs):
//   node scripts/assets.mjs
// CI runs it and fails if anything it writes differs from what's committed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const write = (file, text) => writeFileSync(path.join(root, file), text);

const palette = JSON.parse(read("assets/palette.json"));
const snail = read("assets/logo/snail.svg")
  .replace(/<!--[\s\S]*?-->\s*/, "")
  .trim();
const paint = (color) => snail.replaceAll("currentColor", color);
const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

// --- the logo, on its circle ----------------------------------------------------
const logo = (theme) =>
  svg(
    "0 0 512 512",
    `<circle cx="256" cy="256" r="256" fill="${theme.bg}"/>${paint(theme.rec)}`,
  );
write("assets/logo/scribe.svg", logo(palette.dark));
write("assets/logo/scribe-light.svg", logo(palette.light));

// --- the mark: the snail alone, cropped to its real bounds -------------------------
// Bounds from every coordinate in the drawing: path points (curve control points
// only widen the box), half of each stroke, and each circle's radius.
function bounds() {
  const [, dx, dy] = /translate\(([\d.-]+),([\d.-]+)\)/.exec(snail).map(Number);
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x, y, pad) => {
    box[0] = Math.min(box[0], x - pad + dx);
    box[1] = Math.min(box[1], y - pad + dy);
    box[2] = Math.max(box[2], x + pad + dx);
    box[3] = Math.max(box[3], y + pad + dy);
  };
  for (const [, d, rest] of snail.matchAll(/<path d="([^"]+)"([^>]*)>/g)) {
    const pad = Number(/stroke-width="([\d.]+)"/.exec(rest)?.[1] ?? 0) / 2;
    const nums = d.match(/-?[\d.]+/g).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2)
      grow(nums[i], nums[i + 1], pad);
  }
  for (const [, cx, cy, r] of snail.matchAll(
    /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g,
  )) {
    grow(Number(cx), Number(cy), Number(r));
  }
  return box;
}
const [x0, y0, x1, y1] = bounds();
const margin = 4;
const markBox = [
  x0 - margin,
  y0 - margin,
  x1 - x0 + 2 * margin,
  y1 - y0 + 2 * margin,
]
  .map((n) => Math.round(n * 10) / 10)
  .join(" ");
write("assets/logo/mark.svg", svg(markBox, paint(palette.dark.rec)));

// --- toolbar icons: the shell, enlarged -----------------------------------------
// The shell is the drawing's only path drawn as an unfilled stroke.
const shell =
  /<path d="([^"]+)" fill="none" stroke="currentColor" stroke-width="([\d.]+)"/.exec(
    snail,
  );
const shellBounds = (() => {
  const nums = shell[1].match(/-?[\d.]+/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  const pad = Number(shell[2]) / 2;
  return [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ];
})();
const shellCenter = [
  (shellBounds[0] + shellBounds[2]) / 2,
  (shellBounds[1] + shellBounds[3]) / 2,
];
const SHELL_SCALE = 2.6;
// Thicker strokes (logo units, before scaling) at small sizes, so it stays legible.
const ICON_STROKES = { 16: 14, 32: 12, 48: 12, 128: 10 };
const work = mkdtempSync(path.join(tmpdir(), "scribe-assets-"));
for (const [size, stroke] of Object.entries(ICON_STROKES)) {
  const file = path.join(work, `icon${size}.svg`);
  writeFileSync(
    file,
    svg(
      "0 0 512 512",
      `<g transform="translate(256,256) scale(${SHELL_SCALE}) translate(${-shellCenter[0]},${-shellCenter[1]})">` +
        `<path d="${shell[1]}" fill="none" stroke="${palette.dark.rec}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></g>`,
    ),
  );
  execFileSync("magick", [
    "-background",
    "none",
    "-density",
    "384",
    file,
    "-resize",
    `${size}x${size}`,
    // No timestamps or other metadata, so a rerun produces identical files.
    "-strip",
    "-define",
    "png:exclude-chunks=date,time",
    path.join(root, "extension", "public", "icons", `icon${size}.png`),
  ]);
}

// --- marked blocks in the stylesheets and the web UI ---------------------------
// Replaces the text between `start` and `end` (kept) in a file.
function fill(file, start, end, text) {
  const src = read(file);
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0)
    throw new Error(`${file}: markers ${start} … ${end} not found`);
  write(file, src.slice(0, a + start.length) + text + src.slice(b));
}
const cssVars = (indent) =>
  "\n" +
  Object.entries(palette.dark)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join("\n") +
  `\n${indent}`;
fill(
  "extension/src/popup.css",
  "/* palette:start */",
  "/* palette:end */",
  cssVars("  "),
);
fill(
  "server/ui.html",
  "/* palette:start */",
  "/* palette:end */",
  cssVars("        "),
);
const favicon = `data:image/svg+xml,${encodeURIComponent(logo(palette.dark).trim())}`;
fill(
  "server/ui.html",
  "<!-- favicon:start -->",
  "<!-- favicon:end -->",
  `\n    <!-- prettier-ignore -->\n    <link rel="icon" type="image/svg+xml" href="${favicon}" />\n    `,
);

const markUri = `data:image/svg+xml,${encodeURIComponent(read("assets/logo/mark.svg").trim())}`;
fill(
  "server/ui.html",
  "<!-- mark:start -->",
  "<!-- mark:end -->",
  `<!-- prettier-ignore --><img alt="" src="${markUri}"/>`,
);

console.log(
  "Wrote the logos, mark, icons, palette blocks, favicon and header mark",
);
