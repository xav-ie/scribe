// The capture engine. Runs in an offscreen document so it has access to the
// DOM APIs (getUserMedia, AudioContext, MediaRecorder) the service worker lacks.
//
// Audio graph:
//
//   tabStream ──▶ tabSource ──┬──▶ ctx.destination   (speakers: keep hearing it)
//                             └──▶ recordDest ──▶ MediaRecorder
//   micStream ──▶ micSource ─────▶ recordDest        (recorded, NOT to speakers)
//
// Capturing a tab mutes its audio for the user until you reconnect it to the
// output. That `tabSource.connect(ctx.destination)` line is the unmute fix.

import type { Message, TranscriptResponse } from './types';

const MIME_TYPE = 'audio/webm;codecs=opus';

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

function send(msg: Message): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function start(opts: {
  streamId: string;
  withMic: boolean;
  endpoint: string;
  saveRaw: boolean;
}): Promise<void> {
  if (session) return;

  try {
    // Audio-only tab capture. Note the non-standard `mandatory` constraints —
    // this is the Chrome tabCapture handshake, not standard getUserMedia.
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-expect-error chrome-specific tabCapture constraints
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: opts.streamId,
        },
      },
      video: false,
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
    const tabSource = ctx.createMediaStreamSource(tabStream);
    tabSource.connect(ctx.destination); // unmute: user keeps hearing the meeting

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

    send({ type: 'RECORDING_STARTED', target: 'popup' });
  } catch (error) {
    teardown();
    send({
      type: 'RECORDING_ERROR',
      target: 'popup',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function stop(): void {
  if (!session) return;
  send({ type: 'RECORDING_FINALIZING', target: 'popup' });
  // Triggers recorder.onstop -> finalize().
  session.recorder.stop();
}

async function finalize(): Promise<void> {
  if (!session) return;
  const { chunks, endpoint, saveRaw } = session;
  const blob = new Blob(chunks, { type: 'audio/webm' });

  if (saveRaw) saveLocally(blob);

  teardown();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: blob,
    });
    if (!res.ok) throw new Error(`service responded ${res.status}`);
    const transcript = (await res.json()) as TranscriptResponse;
    send({ type: 'TRANSCRIPT_READY', target: 'popup', transcript });
  } catch (error) {
    console.error('[offscreen] transcription POST failed', error);
    send({
      type: 'RECORDING_ERROR',
      target: 'popup',
      error: error instanceof Error ? error.message : String(error),
    });
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
