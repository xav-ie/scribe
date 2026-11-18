// Which adapter snapshots a session keeps. They arrive every 10 s from each
// reporting frame; keeping only the ones that changed (plus a heartbeat) lets
// a whole meeting fit, including the moment it ends, however long it runs on.

import type { SpeakerDiagnostics } from './speaker/types';

export type Snapshot = SpeakerDiagnostics & { platform: string; at: number };

// An unchanged frame is still kept this often, to show it was alive.
export const HEARTBEAT_MS = 5 * 60_000;

// What makes two snapshots the same. Meet's speaking rates move constantly,
// so they're left out; a page map always counts as a change.
function signature(s: Snapshot): string {
  const { tiles, names, speaking, muted, ended } = s;
  return JSON.stringify({ tiles, names, speaking, muted, ended });
}

/** Whether `next` is worth keeping after the snapshots already in `kept`. */
export function keepSnapshot(
  kept: readonly Snapshot[],
  next: Snapshot,
): boolean {
  if (next.probe) return true;
  const last = kept.findLast((s) => s.frame === next.frame);
  return (
    !last ||
    next.at - last.at >= HEARTBEAT_MS ||
    signature(last) !== signature(next)
  );
}
