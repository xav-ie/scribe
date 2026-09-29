// Service worker: orchestrates capture AND joins the live streams into a
// speaker-attributed transcript it persists for the popup. It owns no audio
// itself; it brokers a tab MediaStream id to the offscreen document.
//
// Two ASR streams arrive: the TAB audio (remote participants — attributed via
// the active-speaker timeline from the content script) and the local MIC (always
// the user). They're merged by wall-clock time. The join inputs live in
// chrome.storage.local (joinSession) + an in-memory cache, so a streamed word or
// speaker event arriving after the worker was torn down still reconstructs.

import { getSettings } from './config';
import { dlog, expose, setDebug } from './debug';
import { getState, setState } from './state';
import {
  mergeTranscript,
  type Channel,
  type SpeakerSpan,
  type Word,
} from './transcript';
import type { Message } from './types';

const OFFSCREEN_PATH = 'src/offscreen.html';
const SESSION_KEY = 'joinSession';

// The local mic is always attributed to the user — it's the one voice we can
// label with certainty, even while muted. (Make this their name if preferred.)
const MIC_SPEAKER = 'Me';

interface JoinSession {
  active: boolean;
  timeline: SpeakerSpan[];
  tabWords: Word[];
  tabEpoch: number | null;
  /** One entry per mic stream: toggling the mic off and on opens a new one. */
  mic: Channel[];
  rawText: string;
}

const EMPTY_SESSION: JoinSession = {
  active: false,
  timeline: [],
  tabWords: [],
  tabEpoch: null,
  mic: [],
  rawText: '',
};

// In-memory cache so back-to-back events don't race on read-modify-write of
// storage. Reloaded from storage if the worker was torn down between events.
let mem: JoinSession | null = null;

async function session(): Promise<JoinSession> {
  if (mem) return mem;
  const stored = await chrome.storage.local.get(SESSION_KEY);
  mem = (stored[SESSION_KEY] as JoinSession | undefined) ?? {
    ...EMPTY_SESSION,
  };
  return mem;
}

async function saveSession(next: JoinSession): Promise<void> {
  mem = next;
  await chrome.storage.local.set({ [SESSION_KEY]: next });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [
      'USER_MEDIA' as chrome.offscreen.Reason,
      'AUDIO_PLAYBACK' as chrome.offscreen.Reason,
    ],
    justification: 'Stream meeting tab audio for live transcription.',
  });
}

// Recompute the attributed transcript from the current join inputs and persist
// it for the popup.
async function recompute(s: JoinSession): Promise<void> {
  const segments = mergeTranscript(
    { words: s.tabWords, epoch: s.tabEpoch },
    s.mic,
    s.timeline,
    MIC_SPEAKER,
  );
  dlog('[bg] recompute:', segments.length, 'segments | distinct speakers:', [
    ...new Set(segments.map((x) => x.speaker)),
  ]);
  await setState({ segments, rawText: s.rawText });
}

async function startRecording(): Promise<void> {
  const { status } = await getState();
  if (status !== 'idle') return;

  // Optimistic, so a double-click can't start two captures.
  await setState({
    status: 'recording',
    segments: [],
    rawText: '',
    error: undefined,
  });
  await saveSession({ ...EMPTY_SESSION, active: true });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await setState({ status: 'idle', error: 'No active tab to capture.' });
    return;
  }

  const settings = await getSettings();

  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? 'no stream id'));
      else resolve(id);
    });
  });

  await ensureOffscreenDocument();

  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_START',
      target: 'offscreen',
      streamId,
      withMic: settings.withMic,
      wsUrl: settings.wsUrl,
      debug: settings.debug,
    } satisfies Message)
    .catch(() => {});

  // Tell the meeting tab's content script to re-emit the current speaker so the
  // timeline is seeded from the first word. Harmless if no content script there.
  chrome.tabs
    .sendMessage(tab.id, {
      type: 'RESET_SPEAKER',
      target: 'content',
    } satisfies Message)
    .catch(() => {});
}

async function stopRecording(): Promise<void> {
  const { status } = await getState();
  if (status !== 'recording') return;
  const s = await session();
  await saveSession({ ...s, active: false });
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_STOP',
      target: 'offscreen',
    } satisfies Message)
    .catch(() => {});
  await setState({ status: 'idle' });
}

async function onTranscriptUpdate(
  channel: 'tab' | 'mic',
  words: Word[],
  text: string,
  captureStartEpoch: number,
): Promise<void> {
  const s = await session();
  if (!s.active) return;
  const next: JoinSession =
    channel === 'mic'
      ? {
          ...s,
          mic: [
            ...s.mic.filter((c) => c.epoch !== captureStartEpoch),
            { words, epoch: captureStartEpoch },
          ],
        }
      : { ...s, tabWords: words, tabEpoch: captureStartEpoch, rawText: text };
  await saveSession(next);
  await recompute(mem!);
}

async function onSpeakerEvent(name: string, atEpoch: number): Promise<void> {
  const s = await session();
  if (!s.active) {
    dlog('[bg] speaker dropped (not recording):', name);
    return;
  }
  // Collapse repeats: only a genuine change starts a new span.
  if (s.timeline.at(-1)?.name === name) {
    dlog('[bg] speaker dropped (same as current):', name);
    return;
  }
  const timeline = [...s.timeline, { name, from: atEpoch }];
  dlog(
    '[bg] speaker:',
    name,
    '| timeline:',
    timeline.map((t) => t.name),
  );
  await saveSession({ ...s, timeline });
  await recompute(mem!);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.target !== 'background') return;
  switch (message.type) {
    case 'START_RECORDING': {
      startRecording().catch((error) =>
        setState({ status: 'idle', error: errorMessage(error) }),
      );
      break;
    }
    case 'STOP_RECORDING': {
      stopRecording().catch(() => {});
      break;
    }
    case 'STATE_UPDATE': {
      setState(message.patch).catch(() => {});
      break;
    }
    case 'TRANSCRIPT_UPDATE': {
      onTranscriptUpdate(
        message.channel,
        message.words,
        message.text,
        message.captureStartEpoch,
      ).catch(() => {});
      break;
    }
    case 'SPEAKER_EVENT': {
      onSpeakerEvent(message.name, message.atEpoch).catch(() => {});
      break;
    }
  }
});

// Drop stale state on reload/restart: if storage says we're recording but the
// offscreen context is gone, nothing is actually streaming — reset so the popup
// isn't stuck. (Registered as listeners, not top-level await — MV3 forbids it.)
async function reconcileStaleState(): Promise<void> {
  const { status } = await getState();
  if (status !== 'idle' && !(await hasOffscreenDocument())) {
    await setState({ status: 'idle' });
    const s = await session();
    await saveSession({ ...s, active: false });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  reconcileStaleState().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  reconcileStaleState().catch(() => {});
});

// Relay a mid-recording "capture microphone" toggle to the offscreen doc so the
// mic is added/removed in the live audio graph without a stop/start. No-op when
// idle (the next start picks the setting up normally).
async function relayMic(enabled: boolean): Promise<void> {
  const { status } = await getState();
  if (status !== 'recording') return;
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_SET_MIC',
      target: 'offscreen',
      enabled,
    } satisfies Message)
    .catch(() => {});
}

// --- debug + live settings ----------------------------------------------
// Keep the debug flag in sync with the popup toggle (no reload needed), and
// relay the mic toggle to a live recording.
chrome.storage.sync.get({ debug: false }, (s) => setDebug(Boolean(s.debug)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.debug) {
    setDebug(Boolean(changes.debug.newValue));
    dlog('[bg] debug logging enabled');
  }
  if (changes.withMic) {
    relayMic(Boolean(changes.withMic.newValue)).catch(() => {});
  }
});

// Console test API — run from the service-worker DevTools console
// (chrome://extensions → this extension → "service worker" → Inspect):
//   await scribe.session()   inspect the live timeline / words / epochs
//   await scribe.state()     the persisted RecState (segments the popup shows)
//   scribe.inject('Alice')   fake an active-speaker change — proves the join works
//                            independently of DOM detection
//   await scribe.reset()     clear + arm a fresh join session
expose('scribe', {
  state: () => getState(),
  session: () => session(),
  inject: (name: string) => onSpeakerEvent(name, Date.now()),
  reset: () => saveSession({ ...EMPTY_SESSION, active: true }),
});
