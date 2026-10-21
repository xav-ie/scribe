// Durable recording state in chrome.storage.local — the single source of truth
// the popup reflects. Using storage (not in-memory background state) means the
// UI survives the popup being closed and the service worker being torn down
// mid-stream: reopen the popup and the live transcript is still there.

import type { RecordingStatus } from './types';
import type { Segment } from './transcript';

export interface RecState {
  status: RecordingStatus;
  /** Speaker-attributed transcript, recomputed live as words + speaker events arrive. */
  segments?: Segment[];
  /** The tab's words without speakers; the popup's fallback when there are no segments. */
  rawText?: string;
  /** Present when the last run failed. Cleared on the next start. */
  error?: string;
  /** Recording works but something is degraded (e.g. no speaker detection). */
  warning?: string;
  /** The server answered that it has no access token: anyone can use it. */
  insecure?: boolean;
  /** The input device the mic stream opened and its settings, for debugging. */
  micDevice?: string;
  updatedAt: number;
}

const KEY = 'recState';
/** chrome.storage.local key of the background's join inputs (see background.ts). */
export const JOIN_SESSION_KEY = 'joinSession';
const INITIAL: RecState = { status: 'idle', updatedAt: 0 };

export async function getState(): Promise<RecState> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as RecState | undefined) ?? INITIAL;
}

// Patches are applied one at a time: two overlapping read-modify-writes would
// otherwise drop one of them (e.g. an error landing during a status change).
// Only the background worker writes state, so one queue per context suffices.
let writes: Promise<unknown> = Promise.resolve();

export function setState(patch: Partial<RecState>): Promise<RecState> {
  const next = writes.then(async () => {
    const state: RecState = {
      ...(await getState()),
      ...patch,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ [KEY]: state });
    return state;
  });
  writes = next.catch(() => {});
  return next;
}

export function onStateChange(callback: (state: RecState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[KEY];
    if (area === 'local' && change?.newValue) {
      callback(change.newValue as RecState);
    }
  });
}
