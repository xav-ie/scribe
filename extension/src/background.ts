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
  onStateChange,
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
import { meetingKey, meetingTitle, meetingUrl } from './meeting';

const OFFSCREEN_PATH = 'src/offscreen.html';
// Adapter snapshots arrive every 10 s; keep about two hours of them.
const MAX_DIAGNOSTICS = 720;

// Restarting a recording in the same meeting this soon after the last one
// stopped resumes that session: one transcript and one set of saved audio.
const RESUME_WITHIN_MS = 30 * 60_000;

// The local mic is always attributed to the user — it's the one voice we can
// label with certainty. (Make this their name if preferred.)
const MIC_SPEAKER = 'Me';

interface JoinSession {
  active: boolean;
  /** Names this recording on the streaming service, including its saved audio. */
  sessionId: string | null;
  /** Names the current capture; the offscreen tags its reports with it. */
  captureId: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  /** The meeting's address, without its query (see meetingUrl). */
  url: string | null;
  /** The meeting's name from its tab title, when it has one (see meetingTitle). */
  title: string | null;
  /** The captured tab; only its content script's diagnostics are kept. */
  tabId: number | null;
  /** The settings it records under, which the streaming service acts on once
   * the record arrives: correct speakers by voice, then keep the audio or not. */
  saveAudio: boolean;
  voices: boolean;
  /** Meeting client, from the captured tab's host (meet, zoom, or the host). */
  platform: string | null;
  timeline: SpeakerSpan[];
  /** One entry per capture: resuming the session opens a new one. */
  tab: Stream[];
  /** One entry per mic stream: the mic reopening (a new device) opens a new one. */
  mic: Stream[];
  /** What the platform adapter saw during the recording, for debug bundles. */
  diagnostics: (SpeakerDiagnostics & { platform: string; at: number })[];
}

// A fresh session every time: the lists are mutated in place, so they must
// never be shared between sessions.
function emptySession(): JoinSession {
  return {
    active: false,
    sessionId: null,
    captureId: null,
    startedAt: null,
    stoppedAt: null,
    url: null,
    title: null,
    tabId: null,
    saveAudio: false,
    voices: false,
    platform: null,
    timeline: [],
    tab: [],
    mic: [],
    diagnostics: [],
  };
}

interface Stream extends Channel {
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
    // Over the defaults, so a copy saved by an older version gains new fields.
    mem ??= {
      ...emptySession(),
      ...(stored[SESSION_KEY] as Partial<JoinSession> | undefined),
    };
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
  const segments = mergeTranscript(s.tab, s.mic, s.timeline, MIC_SPEAKER);
  dlog('[bg] recompute:', segments.length, 'segments | distinct speakers:', [
    ...new Set(segments.map((x) => x.speaker)),
  ]);
  const rawText = s.tab
    .flatMap((t) => t.words)
    .map((w) => w.word)
    .join(' ');
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

  const url = meetingUrl(tab.url);
  const captureId = crypto.randomUUID();
  const resumed = resumes(previous, url) ? previous.sessionId : null;
  const sessionId = resumed ?? crypto.randomUUID();
  if (resumed) {
    // Same meeting, stopped moments ago: carry on in that session. Its words
    // and timeline stay, and this capture adds a tab stream (and saved audio)
    // of its own. The earlier record was uploaded; the next upload replaces it.
    mem = {
      ...previous,
      active: true,
      captureId,
      url,
      title: meetingTitle(tab.title) ?? previous.title,
      tabId: tab.id,
      saveAudio: settings.saveAudio,
      voices: settings.voices,
    };
    dlog('[bg] resuming session', previous.sessionId);
    await recompute(mem);
  } else {
    mem = {
      ...emptySession(),
      active: true,
      sessionId,
      captureId,
      startedAt: Date.now(),
      url,
      title: meetingTitle(tab.title),
      tabId: tab.id,
      platform: platformOf(tab.url),
      saveAudio: settings.saveAudio,
      voices: settings.voices,
    };
  }
  resyncRequested = false;
  await flushSession();
  // Stop can land during any of the waits below; it ends the session, and
  // this start must then not go on to capture.
  const stopped = () => mem?.captureId !== captureId || !mem.active;

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

  capturing = captureId;
  const server = splitServerUrl(settings.wsUrl);
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_START',
      target: 'offscreen',
      streamId,
      wsUrl: server.url,
      token: server.token,
      debug: settings.debug,
      sessionId,
      captureId,
      // Voice correction reads the saved audio; the server drops it after
      // unless saveAudio is on.
      saveAudio: settings.saveAudio || settings.voices,
      boost,
      tabId: tab.id,
      timeline: mem?.timeline ?? [],
      micSpeaker: MIC_SPEAKER,
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

function resumes(previous: JoinSession, url: string | null): boolean {
  const key = meetingKey(url);
  return (
    key !== null &&
    previous.sessionId !== null &&
    previous.stoppedAt !== null &&
    Date.now() - previous.stoppedAt < RESUME_WITHIN_MS &&
    meetingKey(previous.url) === key
  );
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
// How long a freshly injected speaker script gets to come up: 20 × 150 ms.
const INJECT_POLLS = 20;
const INJECT_POLL_MS = 150;

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
  // The injected loader only starts an async import of the script, which
  // registers its listener once loaded, so executeScript resolves first.
  for (let i = 0; i < INJECT_POLLS; i++) {
    if (await reset()) return true;
    await new Promise((resolve) => setTimeout(resolve, INJECT_POLL_MS));
  }
  return 'Speaker detection is not running on this tab, so everyone will show as Unknown and muting is not detected. Reload the meeting tab and start again.';
}

// The capture the offscreen document was told to start.
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
  const id = mem?.captureId;
  // `capturing` is lost when the worker restarts mid-recording; the offscreen
  // document then tells whether a capture may still be flushing its words.
  const flushing =
    capturing === id || (capturing === null && (await hasOffscreenDocument()));
  if (id && flushing) {
    setTimeout(() => {
      if (mem?.captureId === id) finishSession().catch(() => {});
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
  s.stoppedAt = Date.now();
  // Meet names the tab after the meeting only once joined; the tab may be
  // closed by now, leaving the title read at the start.
  if (s.tabId !== null) {
    const tab = await chrome.tabs.get(s.tabId).catch(() => {});
    s.title = meetingTitle(tab?.title) ?? s.title;
  }
  await recompute(s);
  await flushSession();
  // A start that failed before any stream sent words leaves nothing worth a
  // record; uploading it would only add a blank session to the server.
  if (!s.sessionId || (s.tab.length === 0 && s.mic.length === 0)) return;
  const { segments = [], rawText = '' } = await getState();
  const { sessionId } = s;
  await updateUnsent((unsent) => {
    unsent[sessionId] = {
      ...s,
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
      const body = JSON.stringify(unsent[id]);
      const res = await fetch(apiUrl(wsUrl, `/api/sessions/${id}`), {
        signal: AbortSignal.timeout(15_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders(wsUrl) },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A resumed session queues a newer record under the same id, which may
      // land while this one uploads; it must stay queued.
      await updateUnsent((latest) => {
        if (JSON.stringify(latest[id]) === body) delete latest[id];
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
  // Streams are told apart by their clock: a stream of the previous capture
  // can still be sending its last words after the session resumed.
  const streams = channel === 'mic' ? s.mic : s.tab;
  let stream = streams.find((c) => c.epoch === captureStartEpoch);
  if (!stream) {
    stream = { words: [], epoch: captureStartEpoch };
    streams.push(stream);
  }
  const target = stream.words;
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
  const span = { name, from: atEpoch };
  s.timeline.push(span);
  if (s.sessionId)
    chrome.runtime
      .sendMessage({
        type: 'SPEAKER_SPAN',
        target: 'offscreen',
        sessionId: s.sessionId,
        span,
      } satisfies Message)
      .catch(() => {});
  dlog(
    '[bg] speaker:',
    name,
    '| timeline:',
    s.timeline.map((t) => t.name),
  );
  saveSession();
  scheduleRecompute();
}

// The offscreen document reporting on a capture: started, failed, or done
// (its last words in). A late report about an earlier capture is dropped,
// including one from before this session resumed.
async function onStateUpdate(
  captureId: string,
  patch: Partial<RecState>,
): Promise<void> {
  const s = await session();
  if (captureId !== s.captureId) {
    dlog('[bg] state dropped (earlier capture):', captureId, patch);
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
      onStateUpdate(message.captureId, message.patch).catch(() => {});
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

// The toolbar icon says what the popup would: REC while recording, ! when the
// last recording ended in an error (a dropped server stops it unseen). Driven
// by the stored state, so every way the status changes updates it. Colors are
// the popup palette's readable pairs: white on --button, --bg on --warn.
function badgeFor({
  status,
  error,
}: RecState): [string, string, string, string] {
  if (status === 'recording')
    return ['REC', '#c62818', '#ffffff', 'Meeting Capture: recording'];
  if (error) return ['!', '#ffd690', '#1d1711', `Meeting Capture: ${error}`];
  return ['', '#c62818', '#ffffff', 'Meeting Capture'];
}

function showStatus(state: RecState): void {
  const [text, color, textColor, title] = badgeFor(state);
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeTextColor({ color: textColor }).catch(() => {});
  chrome.action.setTitle({ title }).catch(() => {});
}

async function initStatus(): Promise<void> {
  showStatus(await getState());
}
onStateChange(showStatus);
void initStatus();

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

// --- debug + live settings ----------------------------------------------
// Keep the debug flag in sync with the popup toggle (no reload needed).
chrome.storage.sync.get({ debug: false }, (s) => setDebug(Boolean(s.debug)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.debug) {
    setDebug(Boolean(changes.debug.newValue));
    dlog('[bg] debug logging enabled');
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
