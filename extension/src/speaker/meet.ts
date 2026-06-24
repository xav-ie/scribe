// Google Meet active-speaker adapter.
//
// WHY rate-based (not a precise selector): inspection of the live DOM showed Meet
// exposes NO stable hook for the speaking tile — no per-tile attribute/marker, no
// CSS @keyframes animation, and the audio-meter element's every identifier
// (jscontroller / jsname / jsaction / all its classes) is an obfuscated hash that
// Google rotates every couple of months. The ONE durable signal is the physics:
// the speaking participant's audio meter animates, so a `class` attribute inside
// their tile mutates far faster than idle tiles (~58×/8s vs ~3-5×/8s observed).
//
// So: observe the grid for `class` mutations, tally VISIBLE ones per tile in a
// short window, and emit the busiest tile above a threshold. Token-independent —
// it survives Meet's hash churn because it keys on the animation, not its name.
// The only hardcoded selectors are the structural `[data-participant-id]` tile
// and the name wrapper, both stable.

import type { SpeakerAdapter, SpeakerDiagnostics } from './types';

const TILE = 'div[data-participant-id]';
const NAME =
  '[data-tooltip-id][data-tooltip-anchor-boundary-type] span.notranslate';

// Tally window + the per-tile mutation count needed to count as speaking. Speaker
// runs ~5/window, idle tiles ~0.4 — wide margin, so this is forgiving.
const WINDOW_MS = 700;
const MUTATION_THRESHOLD = 2;

function tileName(tile: Element): string | null {
  const el = tile.querySelector<HTMLElement>(NAME);
  return (
    el?.textContent?.trim() || tile.getAttribute('aria-label')?.trim() || null
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
    const counts = new Map<Element, number>();
    let observer: MutationObserver | null = null;
    let tick: ReturnType<typeof setInterval> | undefined;

    const attach = (root: Element) => {
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          const t = m.target;
          // Visible (offsetParent != null) class change inside a tile — the
          // animated audio meter; hidden/offscreen churn doesn't count.
          if (!(t instanceof HTMLElement) || t.offsetParent === null) continue;
          const tile = t.closest(TILE);
          if (tile) counts.set(tile, (counts.get(tile) ?? 0) + 1);
        }
      });
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });

      tick = setInterval(() => {
        let best: Element | null = null;
        let bestN = 0;
        for (const [tile, n] of counts) {
          if (n > bestN) {
            best = tile;
            bestN = n;
          }
        }
        counts.clear();
        if (best && bestN >= MUTATION_THRESHOLD) {
          const name = tileName(best);
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

  diagnose(): SpeakerDiagnostics {
    const tiles = [...document.querySelectorAll(TILE)];
    return {
      tiles: tiles.length,
      names: tiles.map((t) => tileName(t) ?? '?'),
      speaking: lastDetected,
    };
  },
};
