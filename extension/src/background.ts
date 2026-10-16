// Service worker: orchestrates capture AND joins the live streams into a
// speaker-attributed transcript it persists for the popup. It owns no audio
// itself; it brokers a tab MediaStream id to the offscreen document.
//
// Two ASR streams arrive: the TAB audio (remote participants — attributed via
// the active-speaker timeline from the content script) and the local MIC (always
// the user). They're merged by wall-clock time. The join inputs live in
// chrome.storage.local (joinSession) + an in-memory cache, so a streamed word or
// speaker event arriving after the worker was torn down still reconstructs.

import {
  apiHeaders,
  apiUrl,
  BUILD,
  getSettings,
  splitServerUrl,
} from './config';
import { dlog, expose, setDebug } from './debug';
import type { SpeakerDiagnostics } from './speaker/types';
import {
  getState,
  JOIN_SESSION_KEY as SESSION_KEY,
  setState,
  type RecState,
} from './state';
import {
  applyWords,
  mergeTranscript,
  type Channel,
  type SpeakerSpan,
  type Word,
} from './transcript';
import type { Message } from './types';

const OFFSCREEN_PATH = 'src/offscreen.html';
// Adapter snapshots arrive every 10 s; keep about two hours of them.
const MAX_DIAGNOSTICS = 720;

// The local mic is always attributed to the user — it's the one voice we can
// label with certainty, even while muted. (Make this their name if preferred.)
const MIC_SPEAKER = 'Me';

interface JoinSession {
  active: boolean;
  /** Names this recording on the streaming service, including its saved audio. */
  sessionId: string | null;
  startedAt: number | null;
  /** The captured tab; only its content script's diagnostics are kept. */
  tabId: number | null;
  /** Meeting client, from the captured tab's host (meet, zoom, or the host). */
  platform: string | null;
  timeline: SpeakerSpan[];
  tabWords: Word[];
  tabEpoch: number | null;
  /** One entry per mic stream: toggling the mic off and on opens a new one. */
  mic: MicStream[];
  /** What the platform adapter saw during the recording, for debug bundles. */
  diagnostics: (SpeakerDiagnostics & { platform: string; at: number })[];
}

// A fresh session every time: the lists are mutated in place, so they must
// never be shared between sessions.
function emptySession(): JoinSession {
  return {
    active: false,
    sessionId: null,
    startedAt: null,
    tabId: null,
    platform: null,
    timeline: [],
    tabWords: [],
    tabEpoch: null,
    mic: [],
    diagnostics: [],
  };
}

interface MicStream extends Channel {
  words: Word[];
  epoch: number;
}

// While the worker runs, the in-memory session is the source of truth and every
// handler changes it in place (never a copy, which a concurrent handler could
// then save over). Storage holds a copy so a
// session survives the worker being torn down; it is written at most every
// SAVE_EVERY_MS (and immediately at start and stop), and the popup's
// transcript is rebuilt at most every RECOMPUTE_EVERY_MS, instead of rewriting
// the whole session and transcript on every streamed word.
const SAVE_EVERY_MS = 5000;
const RECOMPUTE_EVERY_MS = 1000;

let mem: JoinSession | null = null;
let loading: Promise<JoinSession> | null = null;
// Set when an update shows we're missing words (the worker restarted from a
// copy up to SAVE_EVERY_MS old); cleared once the offscreen doc resends.
let resyncRequested = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let recomputeTimer: ReturnType<typeof setTimeout> | undefined;

// Events arriving together right after the worker wakes share one load, so
// none of them works on (and then saves over) a separate copy.
async function session(): Promise<JoinSession> {
  if (mem) return mem;
  loading ??= chrome.storage.local.get(SESSION_KEY).then((stored) => {
    mem ??= (stored[SESSION_KEY] as JoinSession | undefined) ?? emptySession();
    return mem;
  });
  return loading;
}

function saveSession(): void {
  saveTimer ??= setTimeout(() => void flushSession(), SAVE_EVERY_MS);
}

async function flushSession(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (mem) await chrome.storage.local.set({ [SESSION_KEY]: mem });
}

function scheduleRecompute(): void {
  recomputeTimer ??= setTimeout(() => {
    recomputeTimer = undefined;
    if (mem) recompute(mem).catch(() => {});
  }, RECOMPUTE_EVERY_MS);
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
  clearTimeout(recomputeTimer);
  recomputeTimer = undefined;
  const segments = mergeTranscript(
    { words: s.tabWords, epoch: s.tabEpoch },
    s.mic,
    s.timeline,
    MIC_SPEAKER,
  );
  dlog('[bg] recompute:', segments.length, 'segments | distinct speakers:', [
    ...new Set(segments.map((x) => x.speaker)),
  ]);
  const rawText = s.tabWords.map((w) => w.word).join(' ');
  await setState({ segments, rawText });
}

const NO_SERVER =
  'No scribe server is set. Enter yours in the settings page that just opened.';

async function startRecording(): Promise<void> {
  const { status } = await getState();
  if (status !== 'idle') return;

  // Optimistic, so a double-click can't start two captures.
  await setState({
    status: 'recording',
    segments: [],
    rawText: '',
    error: undefined,
    warning: undefined,
    micDevice: undefined,
  });
  const settings = await getSettings();
  if (!settings.wsUrl) {
    await setState({ status: 'idle', error: NO_SERVER });
    chrome.runtime.openOptionsPage().catch(() => {});
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await setState({ status: 'idle', error: 'No active tab to capture.' });
    return;
  }
  // The last recording may still be waiting for its final words.
  const previous = await session();
  if (previous.active) await finishSession();

  const sessionId = crypto.randomUUID();
  mem = {
    ...emptySession(),
    active: true,
    sessionId,
    startedAt: Date.now(),
    tabId: tab.id,
    platform: platformOf(tab.url),
  };
  resyncRequested = false;
  await flushSession();
  // Stop can land during any of the waits below; it ends the session, and
  // this start must then not go on to capture.
  const stopped = () => mem?.sessionId !== sessionId || !mem.active;

  await ensureOffscreenDocument();

  // Detection first: it also yields the participants' names, which the
  // streaming service boosts so they're transcribed right.
  const detecting = await startSpeakerDetection(tab.id, platformOf(tab.url));
  const boost = detecting === true ? await participantNames(tab.id) : [];
  if (stopped()) return;

  // Last, right before it's used: the capture id goes stale within seconds,
  // and injecting detection into a tab that missed it can take that long.
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? 'no stream id'));
      else resolve(id);
    });
  });
  if (stopped()) return;

  capturing = sessionId;
  const server = splitServerUrl(settings.wsUrl);
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_START',
      target: 'offscreen',
      streamId,
      withMic: settings.withMic,
      wsUrl: server.url,
      token: server.token,
      debug: settings.debug,
      sessionId,
      saveAudio: settings.saveAudio,
      boost,
      tabId: tab.id,
    } satisfies Message)
    .catch(() => {});
  clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    failSilentStart().catch(() => {});
  }, START_TIMEOUT_MS);

  if (detecting !== true) await setState({ warning: detecting });
  checkServerToken(settings.wsUrl).catch(() => {});
  uploadUnsent().catch(() => {});
}

// Ask the server whether it requires a token; the popup warns while it
// doesn't, since then anyone who can reach it can read every meeting.
async function checkServerToken(wsUrl: string): Promise<void> {
  const res = await fetch(apiUrl(wsUrl, '/api/info'), {
    signal: AbortSignal.timeout(5000),
  });
  const { auth } = (await res.json()) as { auth?: boolean };
  await setState({ insecure: auth === false });
}

// Only the frame showing participant tiles answers (Zoom's meeting runs in an
// iframe), so the reply comes from where the names are; none answering means
// no names yet.
async function participantNames(tabId: number): Promise<string[]> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, {
      type: 'GET_PARTICIPANTS',
      target: 'content',
    } satisfies Message)) as { names?: string[] } | undefined;
    return reply?.names ?? [];
  } catch {
    return [];
  }
}

// The offscreen confirms a start (status 'recording') or reports why it failed.
// Hearing neither means the capture never came up, which must not pass for a
// recording: the popup would say "recording" while nothing is.
const START_TIMEOUT_MS = 15_000;
let startTimer: ReturnType<typeof setTimeout> | undefined;

async function failSilentStart(): Promise<void> {
  const { status } = await getState();
  if (status !== 'recording') return;
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_STOP',
      target: 'offscreen',
    } satisfies Message)
    .catch(() => {});
  await setState({
    status: 'idle',
    error:
      "The recording didn't start: the audio capture never came up. Start it again.",
  });
  await finishSession();
}

const SPEAKER_PLATFORMS = new Set(['meet', 'zoom']);

// Ask the meeting tab's content script to re-emit the current speaker and mute
// state, seeding the timeline from the first word. Chrome only injects declared
// content scripts on page load, so a tab opened before the extension was
// (re)loaded has none: inject it then. Returns true, or a warning for the popup.
async function startSpeakerDetection(
  tabId: number,
  platform: string | null,
): Promise<true | string> {
  if (!platform || !SPEAKER_PLATFORMS.has(platform)) {
    return 'Speaker detection only works on Google Meet and Zoom in the browser, so everyone will show as Unknown and muting is not detected.';
  }
  const reset = () =>
    chrome.tabs
      .sendMessage(tabId, {
        type: 'RESET_SPEAKER',
        target: 'content',
      } satisfies Message)
      .then(
        () => true,
        () => false,
      );
  if (await reset()) return true;
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files,
    });
  } catch (error) {
    dlog('[bg] speaker script injection failed:', errorMessage(error));
  }
  if (await reset()) return true;
  return 'Speaker detection is not running on this tab, so everyone will show as Unknown and muting is not detected. Reload the meeting tab and start again.';
}

// The session the offscreen document was told to capture.
let capturing: string | null = null;
// After a stop, the offscreen document waits for each stream's last words and
// then reports idle, which finishes the session; this is the backstop.
const FINISH_TIMEOUT_MS = 10_000;

async function stopRecording(): Promise<void> {
  const { status } = await getState();
  if (status !== 'recording') return;
  // Stop capturing first; the upload may be slow and must not hold it open.
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_STOP',
      target: 'offscreen',
    } satisfies Message)
    .catch(() => {});
  await setState({ status: 'idle' });
  const id = mem?.sessionId;
  if (id && capturing === id) {
    setTimeout(() => {
      if (mem?.sessionId === id) finishSession().catch(() => {});
    }, FINISH_TIMEOUT_MS);
  } else {
    // Stopped before capture began: nothing to wait for.
    await finishSession();
  }
}

function platformOf(url: string | undefined): string | null {
  if (!url) return null;
  const host = new URL(url).hostname;
  if (host === 'meet.google.com') return 'meet';
  if (host.endsWith('zoom.us')) return 'zoom';
  return host;
}

// End the session once, however the recording stopped (the stop button, or the
// offscreen doc going idle when its socket drops), and hand the streaming
// service the full record so its session browser has the transcript, speaker
// timeline and clocks next to any saved audio.
async function finishSession(): Promise<void> {
  const s = await session();
  if (!s.active) return;
  // Before any await, so the stop button and the offscreen doc going idle (both
  // land here) can't both finish and upload the session.
  s.active = false;
  await recompute(s);
  await flushSession();
  if (!s.sessionId) return;
  const { segments = [], rawText = '' } = await getState();
  const { sessionId } = s;
  await updateUnsent((unsent) => {
    unsent[sessionId] = {
      ...s,
      stoppedAt: Date.now(),
      extensionVersion: BUILD,
      segments,
      rawText,
    };
  });
  await uploadUnsent();
}

// Finished sessions wait here until the streaming service has them, so a failed
// upload is retried (popup opened, next recording started) instead of lost,
// and the popup says why it failed.
const UNSENT_KEY = 'unsentSessions';
const UPLOAD_WARNING = "Couldn't save the last session to scribe";

type Unsent = Record<string, unknown>;

// Every change to the queue goes through here, one at a time, on a fresh read:
// uploads and newly finished sessions overlap, and a change made from a stale
// copy would drop a session.
let unsentQueue: Promise<unknown> = Promise.resolve();
function updateUnsent(change: (unsent: Unsent) => void): Promise<Unsent> {
  const next = unsentQueue.then(async () => {
    const stored = await chrome.storage.local.get(UNSENT_KEY);
    const unsent = (stored[UNSENT_KEY] ?? {}) as Unsent;
    change(unsent);
    await chrome.storage.local.set({ [UNSENT_KEY]: unsent });
    return unsent;
  });
  unsentQueue = next.catch(() => {});
  return next;
}

// One upload run at a time; a run asked for while one is going follows it.
let uploading: Promise<void> = Promise.resolve();
function uploadUnsent(): Promise<void> {
  uploading = uploading.then(uploadEach, uploadEach);
  return uploading;
}

async function uploadEach(): Promise<void> {
  const unsent = await updateUnsent(() => {});
  const ids = Object.keys(unsent);
  if (ids.length === 0) return;
  const { wsUrl } = await getSettings();
  // No server yet: the sessions wait until one is set.
  if (!wsUrl) return;
  try {
    for (const id of ids) {
      const res = await fetch(apiUrl(wsUrl, `/api/sessions/${id}`), {
        signal: AbortSignal.timeout(15_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders(wsUrl) },
        body: JSON.stringify(unsent[id]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await updateUnsent((latest) => {
        delete latest[id];
      });
      dlog('[bg] session uploaded:', id);
    }
    const { warning } = await getState();
    if (warning?.startsWith(UPLOAD_WARNING))
      await setState({ warning: undefined });
  } catch (error) {
    await setState({
      warning: `${UPLOAD_WARNING} (${errorMessage(error)}). It retries when you open this popup.`,
    });
  }
}

async function onTranscriptUpdate(
  channel: 'tab' | 'mic',
  from: number,
  words: Word[],
  captureStartEpoch: number,
): Promise<void> {
  const s = await session();
  if (!s.active) return;
  let target: Word[];
  if (channel === 'mic') {
    let stream = s.mic.find((c) => c.epoch === captureStartEpoch);
    if (!stream) {
      stream = { words: [], epoch: captureStartEpoch };
      s.mic.push(stream);
    }
    target = stream.words;
  } else {
    s.tabEpoch = captureStartEpoch;
    target = s.tabWords;
  }
  // Updates only carry new words, so one starting past what we hold means words
  // went missing: ask the offscreen doc to resend its full lists.
  if (!applyWords(target, from, words)) {
    if (!resyncRequested) {
      resyncRequested = true;
      chrome.runtime
        .sendMessage({
          type: 'OFFSCREEN_RESYNC',
          target: 'offscreen',
        } satisfies Message)
        .catch(() => {});
    }
    return;
  }
  if (from === 0) resyncRequested = false;
  saveSession();
  scheduleRecompute();
}

async function onSpeakerEvent(
  tabId: number | undefined,
  name: string,
  atEpoch: number,
): Promise<void> {
  const s = await session();
  if (!s.active) {
    dlog('[bg] speaker dropped (not recording):', name);
    return;
  }
  // Every meeting tab reports; only the captured one is this recording's.
  if (tabId !== s.tabId) {
    dlog('[bg] speaker dropped (another tab):', name);
    return;
  }
  // Collapse repeats: only a genuine change starts a new span.
  if (s.timeline.at(-1)?.name === name) {
    dlog('[bg] speaker dropped (same as current):', name);
    return;
  }
  s.timeline.push({ name, from: atEpoch });
  dlog(
    '[bg] speaker:',
    name,
    '| timeline:',
    s.timeline.map((t) => t.name),
  );
  saveSession();
  scheduleRecompute();
}

// The offscreen document reporting on a recording: started, failed, or done
// (its last words in). A late report about an earlier recording is dropped.
async function onStateUpdate(
  sessionId: string,
  patch: Partial<RecState>,
): Promise<void> {
  const s = await session();
  if (sessionId !== s.sessionId) {
    dlog('[bg] state dropped (earlier recording):', sessionId, patch);
    return;
  }
  if (patch.status !== undefined) clearTimeout(startTimer);
  await setState(patch);
  if (patch.status === 'idle') await finishSession();
}

async function onSpeakerDiag(
  tabId: number | undefined,
  platform: string,
  diag: SpeakerDiagnostics,
  at: number,
): Promise<void> {
  const s = await session();
  if (!s.active || tabId !== s.tabId) return;
  s.diagnostics.push({ ...diag, platform, at });
  s.diagnostics.splice(0, s.diagnostics.length - MAX_DIAGNOSTICS);
  saveSession();
}

chrome.runtime.onMessage.addListener((message: Message, sender) => {
  if (message.target !== 'background') return;
  switch (message.type) {
    case 'START_RECORDING': {
      startRecording().catch(async (error) => {
        // Nothing was captured: drop the session rather than upload it later.
        if (mem) mem.active = false;
        await flushSession();
        await setState({ status: 'idle', error: errorMessage(error) });
      });
      break;
    }
    case 'STOP_RECORDING': {
      stopRecording().catch(() => {});
      break;
    }
    case 'RETRY_UPLOADS': {
      uploadUnsent().catch(() => {});
      break;
    }
    case 'STATE_UPDATE': {
      onStateUpdate(message.sessionId, message.patch).catch(() => {});
      break;
    }
    case 'TRANSCRIPT_UPDATE': {
      onTranscriptUpdate(
        message.channel,
        message.from,
        message.words,
        message.captureStartEpoch,
      ).catch(() => {});
      break;
    }
    case 'SPEAKER_EVENT': {
      onSpeakerEvent(sender.tab?.id, message.name, message.atEpoch).catch(
        () => {},
      );
      break;
    }
    case 'SPEAKER_DIAG': {
      onSpeakerDiag(
        sender.tab?.id,
        message.platform,
        message.diag,
        message.atEpoch,
      ).catch(() => {});
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
    await finishSession();
  }
}

// The worker is about to be torn down: keep everything the session has so far.
chrome.runtime.onSuspend.addListener(() => {
  flushSession().catch(() => {});
});

// public/mic-hook.js must run in the meeting page's own world before the page
// asks for a mic, which a manifest content script can't do with CRXJS's loader,
// so it's registered here. Install and update both land here.
const MIC_HOOK = 'mic-hook';
async function registerMicHook(): Promise<void> {
  await chrome.scripting
    .unregisterContentScripts({ ids: [MIC_HOOK] })
    .catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: MIC_HOOK,
      js: ['mic-hook.js'],
      matches: ['https://meet.google.com/*', 'https://*.zoom.us/*'],
      world: 'MAIN',
      runAt: 'document_start',
      allFrames: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  reconcileStaleState().catch(() => {});
  // There's no default server: ask for one right away.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
  registerMicHook().catch((error: unknown) => {
    console.warn('[bg] mic hook registration failed:', errorMessage(error));
  });
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
  inject: async (name: string) => {
    const { tabId } = await session();
    return onSpeakerEvent(tabId ?? undefined, name, Date.now());
  },
  reset: () => {
    mem = { ...emptySession(), active: true };
    return flushSession();
  },
});
