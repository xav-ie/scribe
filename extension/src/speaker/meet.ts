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
// So: observe the page for `class` mutations on leaf+empty nodes (excludes hover
// tooltips, which carry children + text), count them PER ELEMENT in a short
// window, and emit the tile of the single highest-rate element above a threshold
// (excludes hover chrome — a leaf <span> that only blips ~1/s when you mouse
// over a tile). Token-independent: keys on the animation, not its hashed name.
// Only the structural `[data-participant-id]` tile + name wrapper are hardcoded.
//
// When the tab loses focus Meet can pop the call out into a Document
// Picture-in-Picture window, moving the tiles and controls into that window's
// own document, so detection and the mute check cover it too.

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

// Document Picture-in-Picture isn't in TypeScript's DOM lib yet.
interface DocumentPictureInPictureEvent extends Event {
  readonly window: Window;
}
interface DocumentPictureInPicture {
  readonly window: Window | null;
  addEventListener(
    type: 'enter',
    listener: (e: DocumentPictureInPictureEvent) => void,
  ): void;
  removeEventListener(
    type: 'enter',
    listener: (e: DocumentPictureInPictureEvent) => void,
  ): void;
}
declare global {
  var documentPictureInPicture: DocumentPictureInPicture | undefined;
}

// The page, plus Meet's picture-in-picture window while it's open.
function meetingDocuments(): Document[] {
  const pip = globalThis.documentPictureInPicture?.window?.document;
  return pip ? [document, pip] : [document];
}

function queryAll<E extends Element>(selector: string): E[] {
  return meetingDocuments().flatMap((d) => [
    ...d.querySelectorAll<E>(selector),
  ]);
}

let lastDetected: string | null = null;
// Per tile, the meter's mutation count in the last window: what detection saw.
let lastRates: Record<string, number> = {};

export const meetAdapter: SpeakerAdapter = {
  platform: 'meet',
  matches: (host) => host.endsWith('meet.google.com'),

  start(onSpeaker) {
    const counts = new Map<HTMLElement, number>();
    // Watch the whole page, not the grid: Meet rebuilds the grid when people
    // join or someone presents, so a root picked at join time goes stale and
    // hides everyone who arrived later. Cheap checks first; offsetParent forces
    // layout, so it runs last. Nodes in the picture-in-picture window belong to
    // its own realm, where `instanceof HTMLElement` is false, hence nodeType.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const t = m.target as HTMLElement;
        if (t.nodeType !== Node.ELEMENT_NODE || t.childElementCount !== 0)
          continue;
        if (!t.closest(TILE) || !isMeter(t)) continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    });
    const watch = (doc: Document): void => {
      observer.observe(doc.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    };
    for (const doc of meetingDocuments()) watch(doc);
    // A closed window's document is gone, and its observation with it.
    const onPip = (e: DocumentPictureInPictureEvent): void => {
      watch(e.window.document);
    };
    globalThis.documentPictureInPicture?.addEventListener('enter', onPip);

    const tick = setInterval(() => {
      // The single fastest-animating element wins — the speaker's meter, not
      // the slow one-off blips from hovering a tile.
      let best: HTMLElement | null = null;
      let bestN = 0;
      const rates: Record<string, number> = {};
      for (const [el, n] of counts) {
        const tile = el.closest(TILE);
        const name = (tile && tileName(tile)) ?? '?';
        rates[name] = Math.max(rates[name] ?? 0, n);
        if (n > bestN) {
          best = el;
          bestN = n;
        }
      }
      counts.clear();
      lastRates = rates;
      if (best && bestN >= MUTATION_THRESHOLD) {
        const tile = best.closest(TILE);
        const name = tile && tileName(tile);
        if (name) {
          lastDetected = name;
          onSpeaker(name);
        }
      }
    }, WINDOW_MS);

    return () => {
      clearInterval(tick);
      observer.disconnect();
      globalThis.documentPictureInPicture?.removeEventListener('enter', onPip);
    };
  },

  // The toolbar mic toggle. Meet sets data-is-muted on it (also on the camera
  // button, so we match the one whose aria-label mentions the microphone). The
  // aria-label flips between "Turn on/off microphone" as a fallback signal.
  // Other microphone-labelled controls (device pickers) are ignored.
  // ⚠️ TUNE ME if Meet changes these — null means "don't gate the mic".
  isMuted(): boolean | null {
    const labelled = queryAll<HTMLElement>('[aria-label*="microphone" i]');
    const flag = labelled.find((el) => el.dataset.isMuted !== undefined)
      ?.dataset.isMuted;
    if (flag !== undefined) return flag === 'true';
    const label = labelled
      .map((el) => el.getAttribute('aria-label') ?? '')
      .find((l) => /turn (?:on|off) microphone/i.test(l));
    if (label === undefined) return null;
    return /turn on microphone/i.test(label);
  },

  diagnose(): SpeakerDiagnostics {
    const tiles = queryAll(TILE);
    return {
      tiles: tiles.length,
      names: tiles.map((t) => tileName(t) ?? '?'),
      speaking: lastDetected,
      rates: lastRates,
    };
  },
};
