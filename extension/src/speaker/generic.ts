// Adapter for meeting sites the user adds on the options page, which the
// extension knows nothing about. It reads only what most web meeting clients
// share: a <video> per participant with their name beside it, the local user's
// own tile marked "local" or "self" or mirrored, and a mic button labelled
// "Mute microphone" / "Unmute microphone".
//
// With no speaking signal to read, the speaker is only known when there is
// exactly one other participant: then everything in the tab audio is theirs.
// Larger calls show as Unknown, as on a site with no adapter.

import type { SpeakerAdapter, SpeakerDiagnostics } from './types';
import { isVisible, queryAll } from './dom';

// How far above a <video> its tile and name can sit.
const MAX_DEPTH = 6;
const MAX_NAME_LENGTH = 60;
const LOCAL_CLASS = /(?:^|[-_])(?:local|self|me|mirror(?:ed)?)(?:$|[-_])/i;
const POLL_MS = 1000;

interface Tile {
  name: string | null;
  local: boolean;
}

function isMirrored(el: Element): boolean {
  const view = el.ownerDocument.defaultView ?? globalThis;
  return /^matrix\(-1,/.test(view.getComputedStyle(el).transform);
}

// The video's tile: its nearest ancestor with text, as long as that ancestor
// holds no other video (which would make it the grid, not the tile).
function tileOf(video: HTMLVideoElement): Tile {
  let local = isMirrored(video);
  let el: HTMLElement | null = video;
  for (let depth = 0; el && depth < MAX_DEPTH; depth++) {
    local ||=
      [...el.classList].some((c) => LOCAL_CLASS.test(c)) || isMirrored(el);
    if (el !== video && el.querySelectorAll('video').length > 1) break;
    // Only innerText leaves out hidden elements and breaks lines between
    // blocks, so its first line is the name label.
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content
    const text = el.innerText?.trim();
    if (text) {
      const name = text.split('\n', 1)[0]?.trim() ?? '';
      return { name: name.length <= MAX_NAME_LENGTH ? name : null, local };
    }
    el = el.parentElement;
  }
  return { name: null, local };
}

function tiles(): Tile[] {
  return queryAll<HTMLVideoElement>('video')
    .filter(isVisible)
    .map((v) => tileOf(v));
}

// The one other participant's name, or null when there are none or several.
function soleRemote(found: Tile[]): string | null {
  const remote = new Set(
    found.filter((t) => !t.local && t.name).map((t) => t.name),
  );
  return remote.size === 1 ? [...remote][0]! : null;
}

export const genericAdapter: SpeakerAdapter = {
  platform: 'generic',
  // Only injected into the sites the user listed, so every page it runs on is
  // one of them.
  matches: () => true,

  start(onSpeaker) {
    const id = setInterval(() => {
      const name = soleRemote(tiles());
      if (name) onSpeaker(name);
    }, POLL_MS);
    return () => clearInterval(id);
  },

  // The mic button names the action it offers: "Unmute microphone" or "Turn on
  // microphone" means you're muted. Requiring a mic word skips buttons that
  // mute someone else ("Mute Alice").
  isMuted(): boolean | null {
    const label = queryAll('button, [role="button"]')
      .map((el) =>
        `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`.trim(),
      )
      .find(
        (l) =>
          /\b(?:mic|microphone)\b/i.test(l) &&
          /\b(?:un)?mute\b|\bturn (?:on|off)\b/i.test(l),
      );
    if (label === undefined) return null;
    return /\bunmute\b|\bturn on\b/i.test(label);
  },

  diagnose(): SpeakerDiagnostics {
    const found = tiles();
    return {
      tiles: found.length,
      // Plain names: they're also the participant list the transcription
      // boosts (GET_PARTICIPANTS).
      names: found.map((t) => t.name ?? '?'),
      speaking: soleRemote(found),
    };
  },
};
