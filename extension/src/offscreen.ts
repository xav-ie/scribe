// The capture engine. Runs in an offscreen document so it has access to the
// DOM APIs (getUserMedia, AudioContext) the service worker lacks.
//
// IMPORTANT: offscreen documents can use chrome.runtime messaging ONLY — not
// chrome.storage. So status/transcript updates go to the background worker,
// which owns storage and does the speaker join.
//
// Audio graph (no MediaRecorder — we stream raw PCM):
//
//   tabStream ─▶ tabSource ─┬─▶ ctx.destination   (speakers: keep hearing it)
//                           └─▶ mix ─▶ pcmTap ─▶ ctx.destination (silent sink)
//   micStream ─▶ micSource ───▶ mix              (mixed in, not to speakers)
//
//   pcmTap (AudioWorklet) posts Float32 blocks → int16 PCM → WebSocket → scribe
//
// The mic source can be added/removed mid-recording (setMic) by connecting to /
// disconnecting from `mix`. Capturing a tab mutes its audio for the user until
// you reconnect it to the output — that `tabSource.connect(ctx.destination)`
// line is the unmute fix.

import type { RecState } from './state';
import type { Message } from './types';
import type { Word } from './transcript';

// The PCM tap worklet module (public/pcm-worklet.js, copied to the dist root).
const WORKLET_URL = 'pcm-worklet.js';
const WORKLET_NAME = 'pcm-tap';

interface Session {
  ctx: AudioContext;
  ws: WebSocket;
  node: AudioWorkletNode;
  /** The summing node the tab + (optional) mic feed; the live mic add/remove point. */
  mix: GainNode;
  tabStream: MediaStream;
  micStream: MediaStream | null;
  micSource: MediaStreamAudioSourceNode | null;
  /** Wall-clock (epoch ms) of the first PCM sample sent — the join's time origin. */
  captureStartEpoch: number | null;
  debug: boolean;
}

let session: Session | null = null;

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
// silent track. We request video for reliability but never read it.
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

// Mic permission must already be granted via the micsetup page; the offscreen
// doc can't prompt. Returns null (and warns) if it isn't granted.
async function openMicStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (error) {
    console.warn('[offscreen] mic capture failed', error);
    return null;
  }
}

// Float32 [-1,1] → little-endian int16 PCM. The scribe service resamples to
// 16 kHz server-side, so we send at the AudioContext's native rate and just
// declare it in the opening config message.
function floatToInt16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length);
  for (const [i, sample] of input.entries()) {
    const s = Math.max(-1, Math.min(1, sample));
    out[i] = s < 0 ? s * 32_768 : s * 32_767;
  }
  return out.buffer;
}

async function start(opts: {
  streamId: string;
  withMic: boolean;
  wsUrl: string;
  debug: boolean;
}): Promise<void> {
  if (session) return;

  try {
    const tabStream = await captureTabStream(opts.streamId);
    const tabAudio = tabStream.getAudioTracks()[0];
    if (!tabAudio)
      throw new Error(
        'Tab capture returned no audio track — nothing to record.',
      );
    tabAudio.enabled = true;

    const micStream = opts.withMic ? await openMicStream() : null;

    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_URL));

    const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]));
    tabSource.connect(ctx.destination); // unmute: user keeps hearing the meeting

    // Mix tab (+ mic) down to a single node feeding the PCM tap.
    const mix = ctx.createGain();
    tabSource.connect(mix);
    let micSource: MediaStreamAudioSourceNode | null = null;
    if (micStream) {
      micSource = ctx.createMediaStreamSource(micStream);
      micSource.connect(mix);
    }

    // The worklet runs the PCM tap on the audio thread (replaces the deprecated
    // ScriptProcessorNode). Route its (silent) output through a muted gain to the
    // destination so the graph keeps pulling it without doubling the audio.
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    mix.connect(node);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);

    const ws = new WebSocket(opts.wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ sampleRate: ctx.sampleRate }));
      if (opts.debug) console.log(`[offscreen] ws open @ ${ctx.sampleRate} Hz`);
    });

    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data as string) as {
          type: string;
          text?: string;
          words?: Word[];
        };
        if (msg.type !== 'partial' || !session) return;
        chrome.runtime
          .sendMessage({
            type: 'TRANSCRIPT_UPDATE',
            target: 'background',
            words: msg.words ?? [],
            text: msg.text ?? '',
            captureStartEpoch: session.captureStartEpoch ?? Date.now(),
          } satisfies Message)
          .catch(() => {});
      } catch (error) {
        console.warn('[offscreen] bad ws message', error);
      }
    });

    ws.addEventListener('error', () => {
      sendState({
        status: 'idle',
        error: `Cannot reach streaming service at ${opts.wsUrl}`,
      });
      teardown();
    });
    ws.addEventListener('close', () => {
      if (session) sendState({ status: 'idle' });
      teardown();
    });

    // Each message is a Float32 block of mixed mono audio from the worklet.
    node.port.addEventListener('message', (e: MessageEvent) => {
      if (!session || ws.readyState !== WebSocket.OPEN) return;
      if (session.captureStartEpoch === null)
        session.captureStartEpoch = Date.now();
      ws.send(floatToInt16(e.data as Float32Array));
    });
    node.port.start();

    session = {
      ctx,
      ws,
      node,
      mix,
      tabStream,
      micStream,
      micSource,
      captureStartEpoch: null,
      debug: opts.debug,
    };
    console.log(`[offscreen] streaming started (mic: ${micStream !== null})`);
    sendState({ status: 'recording' });
  } catch (error) {
    teardown();
    const message = error instanceof Error ? error.message : String(error);
    console.error('[offscreen] start failed:', message);
    sendState({ status: 'idle', error: message });
  }
}

// Add/remove the mic in the running graph when the toggle flips mid-recording.
async function setMic(enabled: boolean): Promise<void> {
  if (!session) return;

  if (enabled && !session.micStream) {
    const micStream = await openMicStream();
    if (!micStream) return;
    // The session may have ended while we awaited the mic permission.
    if (!session) {
      for (const t of micStream.getTracks()) t.stop();
      return;
    }
    const micSource = session.ctx.createMediaStreamSource(micStream);
    micSource.connect(session.mix);
    session.micStream = micStream;
    session.micSource = micSource;
    console.log('[offscreen] mic added live');
  } else if (!enabled && session.micStream) {
    session.micSource?.disconnect();
    for (const t of session.micStream.getTracks()) t.stop();
    session.micStream = null;
    session.micSource = null;
    console.log('[offscreen] mic removed live');
  }
}

function stop(): void {
  if (!session) return;
  console.log('[offscreen] stop requested');
  // Closing the socket flushes the server; teardown stops the tracks/graph.
  teardown();
  sendState({ status: 'idle' });
}

function teardown(): void {
  if (!session) return;
  const s = session;
  session = null; // null first so the close handler doesn't re-enter
  try {
    s.node.disconnect();
  } catch {
    /* already gone */
  }
  if (
    s.ws.readyState === WebSocket.OPEN ||
    s.ws.readyState === WebSocket.CONNECTING
  )
    s.ws.close();
  for (const t of s.tabStream.getTracks()) t.stop();
  for (const t of s.micStream?.getTracks() ?? []) t.stop();
  s.ctx.close().catch(() => {});
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.target !== 'offscreen') return;
  switch (message.type) {
    case 'OFFSCREEN_START': {
      void start(message);
      break;
    }
    case 'OFFSCREEN_SET_MIC': {
      void setMic(message.enabled);
      break;
    }
    case 'OFFSCREEN_STOP': {
      stop();
      break;
    }
  }
});
