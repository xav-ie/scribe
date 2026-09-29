// Google Meet active-speaker adapter.
//
// WHY rate-based (not a precise selector): inspection of the live DOM showed Meet
// exposes NO stable hook for the speaking tile — no per-tile attribute/marker, no
// CSS @keyframes animation, and the audio-meter element's every identifier
// (jscontroller / jsname / jsaction / all its classes) is an obfuscated hash that
// Google rotates every couple of months. The durable signal is the physics: the
// speaking participant's audio meter is a LEAF, text-less <div> whose `class`
// mutates rapidly while they talk (~7/s) — far faster than anything idle.
//
// So: observe the grid for `class` mutations on leaf+empty nodes (excludes hover
// tooltips, which carry children + text), count them PER ELEMENT in a short
// window, and emit the tile of the single highest-rate element above a threshold
// (excludes hover chrome — a leaf <span> that only blips ~1/s when you mouse
// over a tile). Token-independent: keys on the animation, not its hashed name.
// Only the structural `[data-participant-id]` tile + name wrapper are hardcoded.

import type { SpeakerAdapter, SpeakerDiagnostics } from './types';

const TILE = 'div[data-participant-id]';
const NAME =
  '[data-tooltip-id][data-tooltip-anchor-boundary-type] span.notranslate';

// Tally window + per-ELEMENT mutation count to count as speaking. The meter runs
// ~5-6/window; hover chrome blips <1/window — wide margin.
const WINDOW_MS = 800;
const MUTATION_THRESHOLD = 3;

function tileName(tile: Element): string | null {
  const el = tile.querySelector<HTMLElement>(NAME);
  return (
    el?.textContent?.trim() || tile.getAttribute('aria-label')?.trim() || null
  );
}

// The audio meter: a visible leaf (no children), text-less node. Hover tooltips
// have children + ~100 chars of text, so this shape filters them out.
function isMeter(el: HTMLElement): boolean {
  return (
    el.offsetParent !== null &&
    el.childElementCount === 0 &&
    (el.textContent ?? '').trim() === ''
  );
}

// The grid mounts asynchronously; it's two levels up from the first tile.
function gridRoot(): Element | null {
  return document.querySelector(TILE)?.parentElement?.parentElement ?? null;
}

let lastDetected: string | null = null;

export const meetAdapter: SpeakerAdapter = {
  platform: 'meet',
  matches: (host) => host.endsWith('meet.google.com'),

  start(onSpeaker) {
    const counts = new Map<HTMLElement, number>();
    let observer: MutationObserver | null = null;
    let tick: ReturnType<typeof setInterval> | undefined;

    const attach = (root: Element) => {
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          const t = m.target;
          if (!(t instanceof HTMLElement) || !isMeter(t)) continue;
          if (!t.closest(TILE)) continue;
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      });
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });

      tick = setInterval(() => {
        // The single fastest-animating element wins — the speaker's meter, not
        // the slow one-off blips from hovering a tile.
        let best: HTMLElement | null = null;
        let bestN = 0;
        for (const [el, n] of counts) {
          if (n > bestN) {
            best = el;
            bestN = n;
          }
        }
        counts.clear();
        if (best && bestN >= MUTATION_THRESHOLD) {
          const tile = best.closest(TILE);
          const name = tile && tileName(tile);
          if (name) {
            lastDetected = name;
            onSpeaker(name);
          }
        }
      }, WINDOW_MS);
    };

    let boot: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      const root = gridRoot();
      if (root) {
        clearInterval(boot);
        boot = undefined;
        attach(root);
      }
    }, 500);

    return () => {
      if (boot) clearInterval(boot);
      if (tick) clearInterval(tick);
      observer?.disconnect();
    };
  },

  // The toolbar mic toggle. Meet sets data-is-muted on it (also on the camera
  // button, so we match the one whose aria-label mentions the microphone). The
  // aria-label flips between "Turn on/off microphone" as a fallback signal.
  // ⚠️ TUNE ME if Meet changes these — null means "don't gate the mic".
  isMuted(): boolean | null {
    const labelled = [
      ...document.querySelectorAll<HTMLElement>('[aria-label*="microphone" i]'),
    ];
    const btn =
      labelled.find((el) => el.dataset.isMuted !== undefined) ?? labelled[0];
    if (!btn) return null;
    const flag = btn.dataset.isMuted;
    if (flag !== undefined) return flag === 'true';
    return /turn on microphone/i.test(btn.getAttribute('aria-label') ?? '');
  },

  diagnose(): SpeakerDiagnostics {
    const tiles = [...document.querySelectorAll(TILE)];
    return {
      tiles: tiles.length,
      names: tiles.map((t) => tileName(t) ?? '?'),
      speaking: lastDetected,
    };
  },
};
