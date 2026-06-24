// The capture engine. Runs in an offscreen document so it has access to the
// DOM APIs (getUserMedia, AudioContext, MediaRecorder) the service worker lacks.
//
// IMPORTANT: offscreen documents can use chrome.runtime messaging ONLY — not
// chrome.storage and not other extension APIs. So state transitions are sent to
// the background worker (STATE_UPDATE), which persists them to storage.
//
// Audio graph:
//
//   tabStream ──▶ tabSource ──┬──▶ ctx.destination   (speakers: keep hearing it)
//                             └──▶ recordDest ──▶ MediaRecorder
//   micStream ──▶ micSource ─────▶ recordDest        (recorded, NOT to speakers)
//
// Capturing a tab mutes its audio for the user until you reconnect it to the
// output. That `tabSource.connect(ctx.destination)` line is the unmute fix.

import type { RecState } from './state';
import type { Message, TranscriptResponse } from './types';

const MIME_TYPE = 'audio/webm;codecs=opus';
// WhisperX large-v3 + diarization on a GPU can take a while; allow a generous
// window, but cap it so a genuinely hung request surfaces as an error rather
// than leaving the UI in "finalizing" forever.
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

interface Session {
  ctx: AudioContext;
  recorder: MediaRecorder;
  tabStream: MediaStream;
  micStream: MediaStream | null;
  chunks: Blob[];
  endpoint: string;
  saveRaw: boolean;
}

let session: Session | null = null;

// Report a state transition to the background worker, which owns chrome.storage.
function sendState(patch: Partial<RecState>): void {
  chrome.runtime
    .sendMessage({
      type: 'STATE_UPDATE',
      target: 'background',
      patch,
    } satisfies Message)
    .catch(() => {});
}

// Chrome's tab capture reliably yields a usable audio track only when video is
// requested alongside it — audio-only tab constraints frequently hand back a
// silent/empty track. We request video for reliability but never record it.
function tabConstraints(
  streamId: string,
  withVideo: boolean,
): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  return {
    // @ts-expect-error non-standard Chrome tabCapture constraints
    audio: { mandatory },
    // @ts-expect-error non-standard Chrome tabCapture constraints
    video: withVideo ? { mandatory } : false,
  };
}

async function captureTabStream(streamId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(
      tabConstraints(streamId, true),
    );
  } catch (error) {
    console.warn(
      '[offscreen] tab audio+video capture failed; retrying audio-only',
      error,
    );
    return navigator.mediaDevices.getUserMedia(tabConstraints(streamId, false));
  }
}

// Logs the RMS level of a source every couple seconds — use it to confirm the
// remote (tab) audio actually carries signal (rms > ~0.005 means sound).
function attachLevelMeter(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  label: string,
): void {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const id = setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    console.log(
      `[offscreen] ${label} level (rms): ${Math.sqrt(sum / buf.length).toFixed(3)}`,
    );
  }, 2000);
  source.mediaStream
    .getAudioTracks()[0]
    ?.addEventListener('ended', () => clearInterval(id));
}

async function start(opts: {
  streamId: string;
  withMic: boolean;
  endpoint: string;
  saveRaw: boolean;
}): Promise<void> {
  if (session) return;

  try {
    // Capture the tab (audio + video; we only record the audio). Requesting
    // video is what makes the audio track actually carry the tab's sound.
    const tabStream = await captureTabStream(opts.streamId);
    const tabAudio = tabStream.getAudioTracks()[0];
    if (!tabAudio) {
      throw new Error(
        'Tab capture returned no audio track — nothing to record.',
      );
    }
    tabAudio.enabled = true;
    console.log('[offscreen] tab audio track:', {
      label: tabAudio.label,
      muted: tabAudio.muted,
      enabled: tabAudio.enabled,
      settings: tabAudio.getSettings(),
    });

    let micStream: MediaStream | null = null;
    if (opts.withMic) {
      // Permission must already be granted via the micsetup page; the offscreen
      // doc cannot show a prompt. If it wasn't granted this throws and we fall
      // back to tab-only.
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
      } catch (error) {
        console.warn(
          '[offscreen] mic capture failed, continuing tab-only',
          error,
        );
        micStream = null;
      }
    }

    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]));
    tabSource.connect(ctx.destination); // unmute: user keeps hearing the meeting
    attachLevelMeter(ctx, tabSource, 'TAB'); // diagnostic: is remote audio flowing?

    const recordDest = ctx.createMediaStreamDestination();
    tabSource.connect(recordDest);

    if (micStream) {
      const micSource = ctx.createMediaStreamSource(micStream);
      micSource.connect(recordDest); // recorded only — not routed to speakers
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(recordDest.stream, {
      mimeType: MediaRecorder.isTypeSupported(MIME_TYPE)
        ? MIME_TYPE
        : 'audio/webm',
    });

    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('stop', () => void finalize());

    recorder.start(1000); // gather a chunk per second so a crash loses ≤1s

    session = {
      ctx,
      recorder,
      tabStream,
      micStream,
      chunks,
      endpoint: opts.endpoint,
      saveRaw: opts.saveRaw,
    };

    console.log(`[offscreen] recording started (mic: ${micStream !== null})`);
    sendState({ status: 'recording' });
  } catch (error) {
    teardown();
    const message = error instanceof Error ? error.message : String(error);
    console.error('[offscreen] start failed:', message);
    sendState({ status: 'idle', error: message });
  }
}

function stop(): void {
  if (!session) return;
  console.log('[offscreen] stop requested');
  sendState({ status: 'finalizing' });
  // Triggers the recorder 'stop' event -> finalize().
  session.recorder.stop();
}

async function finalize(): Promise<void> {
  if (!session) return;
  const { chunks, endpoint, saveRaw } = session;
  const blob = new Blob(chunks, { type: 'audio/webm' });

  if (saveRaw) saveLocally(blob);
  teardown();

  console.log(`[offscreen] finalize: ${blob.size} bytes -> ${endpoint}`);

  if (blob.size === 0) {
    sendState({
      status: 'idle',
      error:
        'Captured 0 bytes — no tab audio was recorded. Make sure the tab is actually playing sound.',
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: blob,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const suffix = detail ? `: ${detail.slice(0, 200)}` : '';
      throw new Error(`service responded ${res.status}${suffix}`);
    }
    const transcript = (await res.json()) as TranscriptResponse;
    console.log(
      `[offscreen] transcript: ${transcript.segments?.length ?? 0} segments`,
    );
    sendState({ status: 'idle', transcript, bytes: blob.size });
  } catch (error) {
    let message: string;
    if (controller.signal.aborted) {
      message = `Transcription timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`;
    } else {
      message = error instanceof Error ? error.message : String(error);
    }
    console.error('[offscreen] transcription POST failed:', message);
    sendState({ status: 'idle', error: message, bytes: blob.size });
  } finally {
    clearTimeout(timer);
  }
}

function saveLocally(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meeting-capture-${Date.now()}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function teardown(): void {
  if (!session) return;
  for (const t of session.tabStream.getTracks()) t.stop();
  for (const t of session.micStream?.getTracks() ?? []) t.stop();
  session.ctx.close().catch(() => {});
  session = null;
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.target !== 'offscreen') return;
  switch (message.type) {
    case 'OFFSCREEN_START': {
      void start(message);
      break;
    }
    case 'OFFSCREEN_STOP': {
      stop();
      break;
    }
  }
});
