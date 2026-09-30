// A per-platform active-speaker detector. Each adapter knows how to read one
// meeting client's DOM for "who is the active speaker right now" and their
// display name, and pushes changes to a callback. Kept tiny and swappable
// because these selectors are the most brittle part of the system — meeting
// clients ship obfuscated, shifting class names, so expect to re-tune them.

import type { DomProbe } from './dom';

export interface SpeakerDiagnostics {
  /** How many participant tiles the adapter found. */
  tiles: number;
  /** The names it could read from those tiles (for selector tuning). */
  names: string[];
  /** Who it currently thinks is speaking, or null. */
  speaking: string | null;
  /** Page map attached while the adapter finds no tiles (see domProbe). */
  probe?: DomProbe;
}

export interface SpeakerAdapter {
  readonly platform: string;
  /** Whether this adapter handles the current page. */
  matches(host: string): boolean;
  /**
   * Begin detecting; call `onSpeaker(name)` whenever the active speaker changes.
   * Meet's speaking signal is an animated indicator mutating (needs a
   * MutationObserver); Zoom's is a stable `--active` class (polled). Returns a
   * stop function.
   */
  start(onSpeaker: (name: string) => void): () => void;
  /**
   * The local user's own mic mute state from the meeting toolbar, or null if it
   * can't be determined (in which case the mic isn't gated). Used to avoid
   * recording your own muted self-talk.
   */
  isMuted?(): boolean | null;
  /** Snapshot for debug logging while tuning selectors. */
  diagnose(): SpeakerDiagnostics;
}
