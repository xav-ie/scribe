// Messages exchanged between popup <-> background <-> offscreen.
// `target` namespaces the message so each context can ignore traffic not meant
// for it (chrome.runtime.sendMessage is a broadcast).

interface StartRecording {
  type: 'START_RECORDING';
  target: 'background';
}

interface StopRecording {
  type: 'STOP_RECORDING';
  target: 'background';
}

interface GetState {
  type: 'GET_STATE';
  target: 'background';
}

// background -> offscreen
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

// offscreen -> background/popup
interface RecordingStarted {
  type: 'RECORDING_STARTED';
  target: 'popup';
}

interface RecordingError {
  type: 'RECORDING_ERROR';
  target: 'popup';
  error: string;
}

interface TranscriptReady {
  type: 'TRANSCRIPT_READY';
  target: 'popup';
  transcript: TranscriptResponse;
}

interface RecordingFinalizing {
  type: 'RECORDING_FINALIZING';
  target: 'popup';
}

export type Message =
  | StartRecording
  | StopRecording
  | GetState
  | OffscreenStart
  | OffscreenStop
  | RecordingStarted
  | RecordingError
  | TranscriptReady
  | RecordingFinalizing;

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
