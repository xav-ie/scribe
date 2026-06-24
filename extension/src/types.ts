// Messages exchanged between popup -> background -> offscreen. Durable UI state
// lives in chrome.storage.local (see state.ts), but ONLY the background worker
// and the popup may touch chrome.storage — the offscreen document has access to
// chrome.runtime messaging only. So the offscreen doc reports state transitions
// to the background via STATE_UPDATE, and the background persists them.

import type { RecState } from './state';

interface StartRecording {
  type: 'START_RECORDING';
  target: 'background';
}

interface StopRecording {
  type: 'STOP_RECORDING';
  target: 'background';
}

// offscreen -> background: persist this patch to storage.
interface StateUpdate {
  type: 'STATE_UPDATE';
  target: 'background';
  patch: Partial<RecState>;
}

interface OffscreenStart {
  type: 'OFFSCREEN_START';
  target: 'offscreen';
  streamId: string;
  withMic: boolean;
  endpoint: string;
  saveRaw: boolean;
}

interface OffscreenStop {
  type: 'OFFSCREEN_STOP';
  target: 'offscreen';
}

export type Message =
  | StartRecording
  | StopRecording
  | StateUpdate
  | OffscreenStart
  | OffscreenStop;

export type RecordingStatus = 'idle' | 'recording' | 'finalizing';

// The shape we expect back from the WhisperX service.
interface TranscriptSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResponse {
  language?: string;
  segments: TranscriptSegment[];
}
