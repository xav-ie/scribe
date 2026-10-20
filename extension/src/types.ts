// Messages exchanged between the contexts. Durable UI state lives in
// chrome.storage.local (see state.ts), but ONLY the background worker and the
// popup may touch chrome.storage — the offscreen document and content scripts
// have chrome.runtime messaging only. So both report to the background, which
// owns storage and does the speaker/word join.
//
//   popup ──START/STOP──▶ background ──OFFSCREEN_START/STOP──▶ offscreen
//   offscreen ──TRANSCRIPT_UPDATE──▶ background   (streamed words)
//   content  ──SPEAKER_EVENT───────▶ background   (active-speaker changes)
//   background ──SPEAKER_SPAN──────▶ offscreen    (relayed to the server)
//   offscreen ──STATE_UPDATE───────▶ background   (status/error)
//   content  ──MUTE_STATE──────────▶ offscreen    (gates the mic stream)

import type { SpeakerDiagnostics } from './speaker/types';
import type { RecState } from './state';
import type { SpeakerSpan, Word } from './transcript';

interface StartRecording {
  type: 'START_RECORDING';
  target: 'background';
}

// popup -> background: retry posting finished sessions scribe doesn't have yet.
interface RetryUploads {
  type: 'RETRY_UPLOADS';
  target: 'background';
}

interface StopRecording {
  type: 'STOP_RECORDING';
  target: 'background';
}

// offscreen -> background: persist this status/error patch to storage.
interface StateUpdate {
  type: 'STATE_UPDATE';
  target: 'background';
  /** The recording this is about; patches for any other are ignored. */
  sessionId: string;
  patch: Partial<RecState>;
}

interface OffscreenStart {
  type: 'OFFSCREEN_START';
  target: 'offscreen';
  streamId: string;
  wsUrl: string;
  /** The server's access token, if it needs one. */
  token?: string;
  debug: boolean;
  /** Identifies this recording on the streaming service (and its saved audio). */
  sessionId: string;
  saveAudio: boolean;
  /** Participant names for the streaming service to boost. */
  boost: string[];
  /** The captured tab: only its mute reports gate the mic. */
  tabId: number;
  /** The speaker timeline so far; later spans follow as SPEAKER_SPAN. */
  timeline: SpeakerSpan[];
  /** Who the mic stream's words are attributed to. */
  micSpeaker: string;
}

// background -> offscreen: the active speaker changed. Sent on the tab stream's
// socket so the server's live view can attribute words as they come.
interface SpeakerSpanUpdate {
  type: 'SPEAKER_SPAN';
  target: 'offscreen';
  sessionId: string;
  span: SpeakerSpan;
}

interface OffscreenStop {
  type: 'OFFSCREEN_STOP';
  target: 'offscreen';
}

// background -> offscreen: resend every stream's full transcript (the
// background noticed missing words, e.g. after its worker restarted).
interface OffscreenResync {
  type: 'OFFSCREEN_RESYNC';
  target: 'offscreen';
}

// offscreen -> background: new words from a stream. They replace that stream's
// words from index `from` on (only the last word sent before can still change).
// Times are stream-relative seconds; `captureStartEpoch` (wall-clock ms of audio
// sample 0) lets the background line them up with the speaker timeline.
interface TranscriptUpdate {
  type: 'TRANSCRIPT_UPDATE';
  target: 'background';
  /** Which ASR stream this is from — the tab audio, or the local mic. */
  channel: 'tab' | 'mic';
  from: number;
  words: Word[];
  captureStartEpoch: number;
}

// content script -> background: the meeting UI's active speaker changed.
interface SpeakerEvent {
  type: 'SPEAKER_EVENT';
  target: 'background';
  name: string;
  atEpoch: number;
}

// content script -> background: a periodic snapshot of what the platform adapter
// sees (tiles, names, active speaker), kept with the session for debug bundles.
interface SpeakerDiag {
  type: 'SPEAKER_DIAG';
  target: 'background';
  platform: string;
  diag: SpeakerDiagnostics;
  atEpoch: number;
}

// content script -> offscreen: the local user's own mic mute state. While muted,
// the offscreen sends silence instead of mic audio, so muted self-talk never
// leaves the machine.
interface MuteState {
  type: 'MUTE_STATE';
  target: 'offscreen';
  muted: boolean;
}

// content script -> offscreen: the mic the meeting page opened, by label, so the
// recording captures the same one.
interface MeetingMic {
  type: 'MEETING_MIC';
  target: 'offscreen';
  label: string;
}

// background -> content script (the captured tab): a new recording started, so
// forget the last-seen speaker and re-emit whoever is currently active, seeding
// the timeline from the very first word.
interface ResetSpeaker {
  type: 'RESET_SPEAKER';
  target: 'content';
}

// background -> content script: the participants' display names. Only a frame
// that sees participant tiles answers.
interface GetParticipants {
  type: 'GET_PARTICIPANTS';
  target: 'content';
}

export type Message =
  | StartRecording
  | RetryUploads
  | StopRecording
  | StateUpdate
  | OffscreenStart
  | OffscreenStop
  | OffscreenResync
  | SpeakerSpanUpdate
  | SpeakerDiag
  | TranscriptUpdate
  | SpeakerEvent
  | MuteState
  | MeetingMic
  | ResetSpeaker
  | GetParticipants;

export type RecordingStatus = 'idle' | 'recording';
