// Durable recording state in chrome.storage.local — the single source of truth
// the popup reflects. Using storage (not in-memory background state + live
// messages) means the UI survives the popup being closed and the service worker
// being torn down mid-transcription: reopen the popup and you still see the
// final transcript or error.

import type { RecordingStatus, TranscriptResponse } from './types';

export interface RecState {
  status: RecordingStatus;
  /** Present once a transcription has come back. Cleared on the next start. */
  transcript?: TranscriptResponse;
  /** Present when the last run failed. Cleared on the next start. */
  error?: string;
  /** Size of the last recording POSTed, for debugging empty captures. */
  bytes?: number;
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
