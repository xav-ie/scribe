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
  /** Cumulative un-attributed ASR text — shown before any speaker events land. */
  rawText?: string;
  /** Present when the last run failed. Cleared on the next start. */
  error?: string;
  updatedAt: number;
}

const KEY = 'recState';
const INITIAL: RecState = { status: 'idle', updatedAt: 0 };

export async function getState(): Promise<RecState> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as RecState | undefined) ?? INITIAL;
}

export async function setState(patch: Partial<RecState>): Promise<RecState> {
  const next: RecState = {
    ...(await getState()),
    ...patch,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [KEY]: next });
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
