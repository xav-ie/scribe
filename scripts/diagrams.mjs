#!/usr/bin/env node
// Generates the model docs' diagrams, charts and comparison tables from two sources:
//   assets/palette.json            the colors: a light and a dark theme
//   models/cleanup/results.json    every measured score (written by the training repo's export)
// It writes models/diagrams/<name>.svg (light) and <name>-dark.svg, and fills the marked
// blocks in the model docs:
//   <!-- diagram:NAME --> … <!-- /diagram:NAME -->  a <picture> with the diagram and its alt text
//   <!-- table:NAME --> … <!-- /table:NAME -->      a markdown table from results.json
// Run in `nix develop`: node scripts/diagrams.mjs
// CI runs it and fails if anything it writes differs from what's committed.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const write = (file, text) => writeFileSync(path.join(root, file), text);
const palette = JSON.parse(read("assets/palette.json"));
const results = JSON.parse(read("models/cleanup/results.json"));
const DIR = "models/diagrams";

// --- primitives -------------------------------------------------------------------
const W = 1062;
const M = 24;
const SIZE = { title: 16, sub: 13.5, label: 13, mono: 12.5 };
const FONT = `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v) => Math.round(v * 10) / 10;
// Deterministic text width estimates, so layout needs no browser.
const textWidth = (s, size) => s.length * size * 0.54;
// Greedy word wrap to a pixel width.
const wrap = (s, size, width) =>
  s.split(" ").reduce(
    (out, word) => {
      const last = out.at(-1);
      if (last && textWidth(`${last} ${word}`, size) > width) out.push(word);
      else out[out.length - 1] = last ? `${last} ${word}` : word;
      return out;
    },
    [""],
  );

// Themes apply through CSS classes, so every diagram body is written once.
// `ink` draws lines and labels; `rec` marks scribe's own parts.
const style = (c) => `<style>
  text { font-family: ${FONT}; fill: ${c.text}; }
  .bg { fill: ${c.bg}; }
  .box { fill: ${c.surface}; stroke: ${c.line}; stroke-width: 2; }
  .key { fill: ${c.rec}; fill-opacity: .12; stroke: ${c.rec}; stroke-width: 2.5; }
  .ask { fill: ${c.surface}; stroke: ${c.border}; stroke-width: 2; stroke-dasharray: 7 5; }
  .end { fill: ${c.border}; fill-opacity: .2; stroke: ${c.border}; stroke-width: 2; }
  .frame { fill: ${c.surface}; stroke: ${c.line}; stroke-width: 1.5; }
  .group { fill: none; stroke: ${c.muted}; stroke-width: 1.5; stroke-dasharray: 6 5; }
  .title { font-size: ${SIZE.title}px; font-weight: 650; }
  .sub { font-size: ${SIZE.sub}px; fill: ${c.muted}; }
  .label { font-size: ${SIZE.label}px; font-weight: 550; fill: ${c.border}; }
  .mono { font-family: ${MONO}; font-size: ${SIZE.mono}px; }
  .edge { fill: none; stroke: ${c.border}; stroke-width: 2; marker-end: url(#arrow); }
  .tag { fill: ${c.bg}; }
  .head { fill: ${c.border}; }
  .ref { stroke: ${c.muted}; stroke-width: 1.5; stroke-dasharray: 4 4; }
  .bar-ours { fill: ${c.rec}; }
  .bar-baseline { fill: ${c.muted}; fill-opacity: .45; }
  .bar-dictation { fill: ${c.border}; fill-opacity: .8; }
</style>`;

const svg = (h, body) =>
  ["light", "dark"].map(
    (theme) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${n(h)}" width="${W}" height="${n(h)}" role="img">` +
      `${style(palette[theme])}<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head" d="M0 0L10 5L0 10z"/></marker></defs>` +
      `<rect class="bg" width="${W}" height="${n(h)}"/>${body}</svg>\n`,
  );

const text = (cls, x, y, s, anchor = "start") =>
  `<text class="${cls}" x="${n(x)}" y="${n(y)}"${anchor === "start" ? "" : ` text-anchor="${anchor}"`}>${esc(s)}</text>`;
const rect = (cls, x, y, w, h, r) =>
  `<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}"/>`;

// Lines of text centered on (x, y): the first as a title, the rest as subtitles.
const lines = (x, y, all) => {
  const height = all.reduce((sum, [, cls]) => sum + SIZE[cls] * 1.35, 0);
  let top = y - height / 2;
  return all
    .map(([s, cls]) => {
      top += SIZE[cls] * 1.35;
      return text(cls, x, top - SIZE[cls] * 0.35, s, "middle");
    })
    .join("");
};

// A box: kind is box (plain), key (scribe's parts), ask (a check) or end.
// Subtitles wrap to the box; `mono` lines sit below them in a frame.
const box = ({ x, y, w, h, text: [title, ...subs], kind = "box", mono }) => {
  const all = [
    [title, "title"],
    ...subs.flatMap((s) => wrap(s, SIZE.sub, w - 24)).map((s) => [s, "sub"]),
  ];
  if (!mono) return rect(kind, x, y, w, h, 14) + lines(x + w / 2, y + h / 2, all);
  const fh = mono.length * 19 + 14;
  const top = y + h - fh - 14;
  return (
    rect(kind, x, y, w, h, 14) +
    lines(x + w / 2, y + (top - y) / 2 + 2, all) +
    rect("frame", x + 14, top, w - 28, fh, 8) +
    mono.map((s, i) => text("mono", x + 26, top + 22 + i * 19, s).replace("<text", `<text xml:space="preserve"`)).join("")
  );
};

// A label on a line, with a background so the line doesn't run through it.
const label = (x, y, s, anchor = "middle") => {
  const w = textWidth(s, SIZE.label) + 12;
  const left = anchor === "middle" ? x - w / 2 : anchor === "start" ? x - 6 : x - w + 6;
  return rect("tag", left, y - 12, w, 19, 5) + text("label", x, y + 2, s, anchor);
};

const arrow = (points) =>
  `<path class="edge" d="M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join("L")}"/>`;

const at = (b) => ({
  top: [b.x + b.w / 2, b.y],
  bottom: [b.x + b.w / 2, b.y + b.h],
  left: [b.x, b.y + b.h / 2],
  right: [b.x + b.w, b.y + b.h / 2],
});

// --- the measured systems ------------------------------------------------------------
// One section of results.json ("test", "comparison" or "reviewed"): the listed systems that have scores there,
// each with its scores merged in.
const section = (name) =>
  results.systems.filter((s) => results[name].scores[s.name]).map((s) => ({ ...s, ...results[name].scores[s.name] }));
const compared = section("comparison");
const models = compared.filter((s) => s.group !== "baseline" || s.size); // what a model can get wrong
const tested = section("test");
const reviewed = section("reviewed");
const pct = (v) => `${+(v * 100).toFixed(1)}%`;

// Bar charts: system names down the left (scribe's own in bold), then one panel per
// metric, each with its own scale, wrapped title and optional dashed reference line.
const ROW = 32;
const chart = ({ data, left, panels }) => {
  const pw = (W - left - M) / panels.length;
  const titles = panels.map((p) => wrap(p.title, SIZE.title, pw - 24));
  const top = Math.max(...titles.map((t) => t.length)) * 21 + 22;
  const bottom = top + data.length * ROW;
  const body =
    data
      .map((s, i) => text(s.group === "ours" ? "title" : "sub", M, top + i * ROW + 16, s.size ? `${s.name} (${s.size})` : s.name))
      .join("") +
    panels
      .map(({ value, fmt, ref }, k) => {
        const x = left + k * pw;
        const max = Math.max(...data.map(value), ref?.value ?? 0);
        const scale = (v) => Math.max((v / max) * (pw - 90), 2);
        return (
          titles[k].map((t, j) => text("title", x, 26 + j * 21, t)).join("") +
          (ref
            ? `<line class="ref" x1="${n(x + scale(ref.value))}" y1="${top - 6}" x2="${n(x + scale(ref.value))}" y2="${bottom}"/>` +
              label(x + scale(ref.value), bottom + 12, ref.label)
            : "") +
          data
            .map((s, i) => {
              const y = top + i * ROW;
              const v = fmt(value(s));
              return (
                rect(`bar-${s.group}`, x, y, scale(value(s)), 22, 4) +
                rect("tag", x + scale(value(s)) + 4, y + 2, textWidth(v, SIZE.sub) + 8, 18, 4) +
                text("sub", x + scale(value(s)) + 8, y + 16, v)
              );
            })
            .join("")
        );
      })
      .join("");
  return { h: bottom + (panels.some((p) => p.ref) ? 34 : 14), body };
};

// --- diagrams ------------------------------------------------------------------------
// Each returns { h, body, alt }.
const diagrams = {
  guards() {
    const x = M, w = W - 2 * M;
    const raw = ["[0:43] Alice: um so the the cost should uh not exceed twelve fifty", "[0:48] Bob: so that's two off the price"];
    const out = ["[0:43] Alice: So the cost should not exceed twelve fifty.", "[0:48] Bob: So that's 20 off the price."];
    const a = { x, y: 24, w, h: 128, text: ["In: a chunk of raw lines", "about 250 words, cleaned together"], mono: raw };
    const step = { x, y: 184, w, h: 316 }; // the whole cleanup step, model and check together
    const b = { x: x + 24, y: 230, w: w - 48, h: 128, text: ["The cleanup model's lines", "one per raw line, same order"], mono: out, kind: "key" };
    const c = { x: x + 180, y: 392, w: w - 360, h: 84, kind: "ask", text: ["Safety check: each line against its original", "same timestamp and speaker, same numbers, every “not” kept"] };
    const d = { x, y: 532, w, h: 128, kind: "end", text: ["Out: the cleaned chunk", "a line that passes is used; a line that fails stays as it was"],
                mono: [`${out[0]}  ← passed`, `${raw[1].padEnd(out[0].length)}  ← failed: “two” became 20`] };
    return {
      h: 684,
      body:
        rect("group", step.x, step.y, step.w, step.h, 16) + text("title", step.x + 18, step.y + 28, "Cleanup") +
        [a, b, c, d].map(box).join("") +
        arrow([at(a).bottom, at(b).top]) +
        arrow([at(b).bottom, at(c).top]) +
        arrow([at(c).bottom, at(d).top]),
      alt: `Cleanup, the model and the safety check together, takes a chunk of raw lines ("${raw.join('", "')}"). The cleanup model returns one line per raw line ("${out.join('", "')}"); the safety check compares each with its raw line for the same timestamp and speaker, the same number values and every "not". The cleaned chunk keeps the first cleaned line, which passed, and the second raw line, because "two" became 20`,
    };
  },

  quality() {
    const raw = compared.find((s) => s.name === "Raw transcript").meetings.fwer;
    const panel = { title: "Errors in words, punctuation and capitals on meetings (lower is better)", value: (s) => s.meetings.fwer, fmt: pct,
                    ref: { value: raw, label: "raw transcript" } };
    return {
      ...chart({ data: compared, left: 300, panels: [panel] }),
      alt: `${panel.title}: ${compared.map((s) => `${s.name} ${pct(s.meetings.fwer)}`).join(", ")}`,
    };
  },

  losses() {
    const panels = [
      { title: "Real words dropped", value: (s) => s.meetings.drop },
      { title: "Chunks where a \"not\" went missing", value: (s) => s.meetings.neg },
      { title: "Chunks with a wrong number (number tests)", value: (s) => s.synthetic.num },
    ].map((p) => ({ ...p, fmt: pct }));
    return {
      ...chart({ data: models, left: 250, panels }),
      alt: panels.map((p) => `${p.title}: ${models.map((s) => `${s.name} ${pct(p.value(s))}`).join(", ")}`).join("; "),
    };
  },
};

// --- tables --------------------------------------------------------------------------
const nameCell = (s) => {
  const name = s.link ? `[${s.name}](${s.link})` : s.name;
  return (s.group === "ours" ? `**${name}**` : name) + (s.note ? ` (${s.note})` : "");
};
const table = (head, data, cells) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...data.map((s) => `| ${cells(s).join(" | ")} |`)].join("\n");
const f2 = (v) => v.toFixed(2);
const chunks = (name, key) => `${results[name].windows[key]} chunks`;
const ours = (rows) => rows.find((s) => s.group === "ours");
const named = (rows, name) => rows.find((s) => s.name === name);

// The score definitions, written once: the methodology lists them all, and each results section links there.
const SCORES = [
  ["Word errors (WER)", "share of words that differ from the correct cleaned text, ignoring punctuation and capitals; the usual score for speech-to-text. Lower is better."],
  ["Word, punctuation and capital errors", "the same, also counting every comma, period and capital letter. Lower is better."],
  ["Punctuation, capitals, filler removal (0 to 1)", "how many of the right fixes it made without making wrong ones (the F1 score): 1 is perfect. Higher is better."],
  ["Real words dropped", "share of real words (not ums) missing from the output. Lower is better."],
  ["Wrong number", "share of chunks where a number's value was lost, changed or added; \"five\" and \"5\" count as the same. Lower is better."],
  ["Missing \"not\"", "share of chunks where a not, no or never disappeared from a sentence. Lower is better."],
  ["Unsure number converted", "share of chunks where a number that could mean several things (\"twelve fifty\") was turned into digits anyway. Lower is better."],
  ["Correction not applied", "share of chunks where \"ten, no wait, four\" kept the ten. Lower is better."],
  ["Lines kept intact", "share of chunks where every line came back with its own timestamp and speaker. Higher is better."],
];
// The released versions, listed the same way in models/README.md, the model card and (copied from the card) the short
// Hugging Face cards.
const VERSIONS = [
  ["scribe-cleanup-mlx-4bit", "Macs with Apple chips (compressed)", "2.8 GB"],
  ["scribe-cleanup-GGUF", "[llama.cpp](https://github.com/ggml-org/llama.cpp), a popular tool for running models locally (compressed)", "3.3 GB"],
  ["scribe-cleanup", "the full-size model, for Python's `transformers` library or [vLLM](https://github.com/vllm-project/vllm) on a server", "9.3 GB"],
  ["scribe-cleanup-lora", "just the trained add-on (LoRA), for building your own versions", "93 MB"],
];
const tables = {
  versions: () =>
    table(["Version", "For", "Size"], VERSIONS, ([repo, use, size]) => [`[\`xav-ie/${repo}\`](https://huggingface.co/xav-ie/${repo})`, use, size]),
  scores: () => table(["Score", "What it means"], SCORES, ([k, v]) => [k, v]),

  // one-sentence verdicts, from the numbers
  "card-verdict": () => {
    const m = ours(tested), raw = named(tested, "Raw transcript");
    return `In short: on meetings it never saw, the cleaned text has ${pct(m.meetings.fwer)} of words, punctuation and capitals ` +
      `wrong, against ${pct(raw.meetings.fwer)} for the raw transcript. After the safety check, ${pct(m.meetings.num_after_guards)} of test ` +
      `chunks had a wrong number and ${pct(m.meetings.neg_after_guards)} a missing "not".`;
  },
  "comparison-verdict": () => {
    const m = ours(compared), dict = compared.filter((s) => s.group === "dictation");
    const lo = (k) => pct(Math.min(...dict.map((s) => s.meetings[k]))), hi = (k) => pct(Math.max(...dict.map((s) => s.meetings[k])));
    return `In short: scribe cleanup makes the fewest errors and drops ${pct(m.meetings.drop)} of real words; the dictation ` +
      `models drop ${lo("drop")} to ${hi("drop")}, and lose a "not" in ${lo("neg")} to ${hi("neg")} of meeting chunks.`;
  },

  // comparison.md: every system on the same chunks
  "comparison-quality": () =>
    `**How clean the result is, on meetings** (${chunks("comparison", "meetings")}; for every score, see [the definitions](METHODOLOGY.md#scoring))\n\n` +
    table(["System", "Size", "Word errors", "Word, punctuation and capital errors", "Punctuation (0 to 1)", "Capitals (0 to 1)", "Filler removal (0 to 1)"], compared, (s) => {
      const m = s.meetings;
      return [nameCell(s), s.size ?? "", pct(m.wer), pct(m.fwer), f2(m.punct_f1), f2(m.caps_f1), s.name === "Raw transcript" ? "n/a" : f2(m.disfl_f1)];
    }),
  "comparison-safety": () =>
    `**What gets lost** (meetings: ${chunks("comparison", "meetings")}; number tests: ${chunks("comparison", "synthetic")})\n\n` +
    table(["System", "Real words dropped", "Missing \"not\"", "Wrong number", "Wrong number (number tests)", "Unsure number converted (number tests)",
           "Correction not applied (number tests)", "Lines kept intact"], models, (s) => [
      nameCell(s), pct(s.meetings.drop), pct(s.meetings.neg), pct(s.meetings.num), pct(s.synthetic.num), pct(s.synthetic.amb),
      pct(s.synthetic.corr), s.group === "dictation" ? "n/a (one line at a time)" : pct(Math.min(s.meetings.struct, s.synthetic.struct)),
    ]),

  // model card: the full test sets
  "test-meetings": () =>
    `**Meetings** (${chunks("test", "meetings")})\n\n` +
    table(["System", "Word errors", "Word, punctuation and capital errors", "Punctuation (0 to 1)", "Capitals (0 to 1)", "Filler removal (0 to 1)", "Wrong number", "Missing \"not\""],
      tested, (s) => {
        const m = s.meetings;
        return [nameCell(s), `${pct(m.wer)} (likely ${pct(m.wer_lo)} to ${pct(m.wer_hi)})`, pct(m.fwer), f2(m.punct_f1), f2(m.caps_f1),
                s.name === "Raw transcript" ? "n/a" : f2(m.disfl_f1), pct(m.num), pct(m.neg)];
      }),
  "test-synthetic": () =>
    `**Number tests**: made-up lines with prices, dates, codes, names, corrections and requests, inserted into real meetings (${chunks("test", "synthetic")})\n\n` +
    table(["System", "Word errors", "Word, punctuation and capital errors", "Wrong number", "Unsure number converted", "Correction not applied", "Lines kept intact"],
      tested, (s) => {
        const y = s.synthetic;
        return [nameCell(s), pct(y.wer), pct(y.fwer), pct(y.num), pct(y.amb), pct(y.corr), pct(y.struct)];
      }),
  "test-guards": () => {
    const m = ours(tested);
    return table(["After the safety check", "Meetings", "Number tests"], [
      ["Chunks with a wrong number", "num_after_guards"], ["Unsure numbers converted", "amb_after_guards"],
      ["Chunks with a missing \"not\"", "neg_after_guards"], ["Lines put back to the raw text", "revert_after_guards"],
    ], ([label, k]) => [label, pct(m.meetings[k]), pct(m.synthetic[k])]);
  },
  reviewed: () =>
    `**Hand-checked lines** (${results.reviewed.lines} meeting lines; ${results.reviewed.status})\n\n` +
    table(["System", "Word errors", "Word, punctuation and capital errors", "Punctuation (0 to 1)", "Capitals (0 to 1)", "Filler removal (0 to 1)"], reviewed, (s) =>
      [nameCell(s), pct(s.wer), pct(s.fwer), f2(s.punct_f1), f2(s.caps_f1), s.name === "Raw transcript" ? "n/a" : f2(s.disfl_f1)]),
};

// --- write ---------------------------------------------------------------------------
mkdirSync(path.join(root, DIR), { recursive: true });
// Only what this script writes lives in DIR: a diagram removed here disappears there too.
for (const f of readdirSync(path.join(root, DIR)))
  if (!Object.keys(diagrams).some((name) => f === `${name}.svg` || f === `${name}-dark.svg`)) unlinkSync(path.join(root, DIR, f));
const built = Object.fromEntries(
  Object.entries(diagrams).map(([name, make]) => {
    const d = make();
    const [light, dark] = svg(d.h, d.body);
    write(`${DIR}/${name}.svg`, light);
    write(`${DIR}/${name}-dark.svg`, dark);
    return [name, d];
  }),
);

// Fills every marked block in a doc; unknown names fail loudly.
const fill = (file) => {
  const rel = path.relative(path.dirname(file), DIR);
  const src = read(file).replace(/<!-- (diagram|table):([\w-]+) -->[\s\S]*?<!-- \/\1:\2 -->/g, (_, kind, name) => {
    let inner;
    if (kind === "diagram") {
      if (!built[name]) throw new Error(`${file}: no diagram ${name}`);
      inner = `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${rel}/${name}-dark.svg">\n  <img src="${rel}/${name}.svg" alt="${esc(built[name].alt).replace(/"/g, "&quot;")}">\n</picture>`;
    } else {
      if (!tables[name]) throw new Error(`${file}: no table ${name}`);
      inner = tables[name]();
    }
    return `<!-- ${kind}:${name} -->\n${inner}\n<!-- /${kind}:${name} -->`;
  });
  write(file, src);
};
["models/README.md", "models/cleanup/MODEL_CARD.md", "models/cleanup/METHODOLOGY.md", "models/cleanup/COMPARISON.md"].forEach(fill);

console.log(`Wrote ${Object.keys(built).length} diagrams and filled the model docs`);
