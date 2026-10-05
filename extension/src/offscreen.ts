// The capture engine. Runs in an offscreen document so it has access to the
// DOM APIs (getUserMedia, AudioContext) the service worker lacks.
//
// IMPORTANT: offscreen documents can use chrome.runtime messaging ONLY — not
// chrome.storage. So status/transcript updates go to the background worker.
//
// Audio graph — the tab and mic are SEPARATE ASR streams (never mixed), so the
// mic can be attributed to the local user while the tab is attributed via the
// active-speaker timeline:
//
//   tabStream ─▶ tabSource ─┬─▶ ctx.destination        (speakers: keep hearing it)
//                           └─▶ pcmTap("tab") ─▶ WS ─▶ scribe  (remote audio)
//   micStream ─▶ micSource ───▶ pcmTap("mic") ─▶ WS ─▶ scribe  (your voice)
//
// Each pcmTap (AudioWorklet) posts Float32 blocks → int16 PCM → its own
// WebSocket. The mic channel can be added/removed mid-recording (setMic).
// Capturing a tab mutes its audio until you reconnect it to the output — that
// `tabSource.connect(ctx.destination)` line is the unmute fix.

import type { RecState } from './state';
import type { Message } from './types';
import type { Word } from './transcript';

// The PCM tap worklet module (public/pcm-worklet.js, copied to the dist root).
const WORKLET_URL = 'pcm-worklet.js';
const WORKLET_NAME = 'pcm-tap';

// One ASR stream: a PCM-tap worklet feeding a WebSocket to the scribe service.
interface Channel {
  ws: WebSocket;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  /** Wall-clock (epoch ms) of this stream's first PCM sample — its time origin. */
  captureStartEpoch: number | null;
  /** Set when we close it deliberately, so the close handler doesn't react. */
  closing: boolean;
  /** The stream's full transcript, kept to resend if the background loses words. */
  words: Word[];
}

interface Session {
  ctx: AudioContext;
  tabStream: MediaStream;
  micStream: MediaStream | null;
  tab: Channel;
  mic: Channel | null;
  stream: StreamOpts;
}

// Per-recording settings every channel's socket needs.
interface StreamOpts {
  wsUrl: string;
  debug: boolean;
  /** Names the recording on the streaming service, which saves audio under it. */
  sessionId: string;
  saveAudio: boolean;
  /** Participant names the streaming service should boost. */
  boost: string[];
}

let session: Session | null = null;

// Bumped by every start and stop. A start still awaiting capture when a stop
// (or another start) lands sees a newer number and backs out, releasing what
// it opened, instead of recording while the background thinks it's idle.
let generation = 0;
// Whether the user wants the mic; checked again once it has opened, so toggling
// it off (or on twice) while permission/capture is pending can't leave a hot
// mic or a second socket.
let micWanted = false;
let micOpening = false;

// While true, the mic streams silence — you're muted, so it isn't recorded.
// Lives outside the session so a report that lands while start() is still
// awaiting capture isn't lost.
let micMuted = false;

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
// doc can't prompt. Returns null (and warns) if it isn't granted. Echo
// cancellation keeps meeting audio from the speakers out of the mic stream,
// which would otherwise transcribe remote speech a second time as "Me".
async function openMicStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
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

// Wire one audio source through a PCM-tap worklet to its own WebSocket. The tab
// channel is `primary`: its socket dropping ends the whole session, whereas the
// mic dropping just removes the mic.
function openChannel(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  stream: StreamOpts,
  channelName: 'tab' | 'mic',
  primary: boolean,
): Channel {
  const { wsUrl, debug } = stream;
  const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  source.connect(node);
  // A worklet only runs while connected to a destination; route its (silent)
  // output through a muted gain so it pulls audio without adding to playback.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const channel: Channel = {
    ws,
    node,
    source,
    captureStartEpoch: null,
    closing: false,
    words: [],
  };

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        sampleRate: ctx.sampleRate,
        sessionId: stream.sessionId,
        channel: channelName,
        save: stream.saveAudio,
        boost: stream.boost,
      }),
    );
    if (debug) {
      console.log(`[offscreen] ${channelName} ws open @ ${ctx.sampleRate} Hz`);
    }
  });

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data as string) as {
        type: string;
        from?: number;
        words?: Word[];
      };
      if (msg.type !== 'words' || !session) return;
      const from = msg.from ?? 0;
      channel.words.splice(from, Infinity, ...(msg.words ?? []));
      sendWords(channel, channelName, from);
    } catch (error) {
      console.warn('[offscreen] bad ws message', error);
    }
  });

  ws.addEventListener('error', () => {
    if (primary) {
      sendState({
        status: 'idle',
        error: `Cannot reach streaming service at ${wsUrl}`,
      });
      teardown();
    } else {
      console.warn('[offscreen] mic stream error; dropping mic');
      removeMic();
    }
  });
  ws.addEventListener('close', () => {
    if (channel.closing) return; // deliberate (stop / mic toggled off)
    if (primary) {
      if (session) sendState({ status: 'idle' });
      teardown();
    } else {
      removeMic();
    }
  });

  node.port.addEventListener('message', (e: MessageEvent) => {
    if (!session || ws.readyState !== WebSocket.OPEN) return;
    if (channel.captureStartEpoch === null) {
      channel.captureStartEpoch = Date.now();
      // The stream's clock, so saved audio can be lined up with the transcript.
      ws.send(JSON.stringify({ epoch: channel.captureStartEpoch }));
    }
    const data = e.data as Float32Array;
    // While muted, stream silence on the mic channel: your voice never leaves
    // the machine and isn't transcribed, but the stream stays time-aligned.
    const pcm =
      channelName === 'mic' && micMuted
        ? new Int16Array(data.length).buffer
        : floatToInt16(data);
    ws.send(pcm);
  });
  node.port.start();

  return channel;
}

// Forward a stream's words from index `from` on to the background.
function sendWords(
  channel: Channel,
  channelName: 'tab' | 'mic',
  from: number,
): void {
  chrome.runtime
    .sendMessage({
      type: 'TRANSCRIPT_UPDATE',
      target: 'background',
      channel: channelName,
      from,
      words: channel.words.slice(from),
      captureStartEpoch: channel.captureStartEpoch ?? Date.now(),
    } satisfies Message)
    .catch(() => {});
}

function closeChannel(ch: Channel): void {
  ch.closing = true;
  try {
    ch.node.disconnect();
    ch.source.disconnect();
  } catch {
    /* already gone */
  }
  if (
    ch.ws.readyState === WebSocket.OPEN ||
    ch.ws.readyState === WebSocket.CONNECTING
  ) {
    ch.ws.close();
  }
}

async function addMic(): Promise<void> {
  if (!session || session.mic || micOpening) return;
  micOpening = true;
  const micStream = await openMicStream().finally(() => {
    micOpening = false;
  });
  if (!micStream) return;
  // The session may have ended, or the mic been toggled off, meanwhile.
  if (!session || session.mic || !micWanted) {
    for (const t of micStream.getTracks()) t.stop();
    return;
  }
  const micSource = session.ctx.createMediaStreamSource(micStream);
  session.micStream = micStream;
  session.mic = openChannel(
    session.ctx,
    micSource,
    session.stream,
    'mic',
    false,
  );
  console.log('[offscreen] mic added');
}

function removeMic(): void {
  if (!session?.mic) return;
  closeChannel(session.mic);
  for (const t of session.micStream?.getTracks() ?? []) t.stop();
  session.mic = null;
  session.micStream = null;
  console.log('[offscreen] mic removed');
}

async function start(
  opts: StreamOpts & { streamId: string; withMic: boolean },
): Promise<void> {
  if (session) return;
  const gen = ++generation;
  micWanted = opts.withMic;

  // Opened here before the session owns them, so a failure or a stop midway
  // releases them too.
  let tabStream: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  const release = (): void => {
    for (const t of tabStream?.getTracks() ?? []) t.stop();
    ctx?.close().catch(() => {});
  };

  try {
    tabStream = await captureTabStream(opts.streamId);
    if (gen !== generation) return release();
    const tabAudio = tabStream.getAudioTracks()[0];
    if (!tabAudio)
      throw new Error(
        'Tab capture returned no audio track — nothing to record.',
      );
    tabAudio.enabled = true;

    ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_URL));
    if (gen !== generation) return release();

    const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]));
    tabSource.connect(ctx.destination); // unmute: user keeps hearing the meeting

    const stream: StreamOpts = {
      wsUrl: opts.wsUrl,
      debug: opts.debug,
      sessionId: opts.sessionId,
      saveAudio: opts.saveAudio,
      boost: opts.boost,
    };
    session = {
      ctx,
      tabStream,
      micStream: null,
      tab: openChannel(ctx, tabSource, stream, 'tab', true),
      mic: null,
      stream,
    };

    if (opts.withMic) await addMic();
    if (gen !== generation) return;

    console.log(`[offscreen] streaming started (mic: ${session?.mic != null})`);
    sendState({ status: 'recording' });
  } catch (error) {
    if (session) teardown();
    else release();
    const message = error instanceof Error ? error.message : String(error);
    console.error('[offscreen] start failed:', message);
    sendState({ status: 'idle', error: message });
  }
}

function stop(): void {
  generation++;
  if (!session) return;
  console.log('[offscreen] stop requested');
  // Closing the sockets flushes the server; teardown stops the tracks/graph.
  teardown();
  sendState({ status: 'idle' });
}

function teardown(): void {
  generation++; // a start still in flight must not report "recording"
  // The offscreen doc outlives recordings; the next one starts unmuted unless
  // the content script reports otherwise (it does just before each start).
  micMuted = false;
  if (!session) return;
  const s = session;
  session = null; // null first so the close handlers don't re-enter
  closeChannel(s.tab);
  if (s.mic) closeChannel(s.mic);
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
    case 'MUTE_STATE': {
      micMuted = message.muted;
      break;
    }
    case 'OFFSCREEN_STOP': {
      stop();
      break;
    }
    case 'OFFSCREEN_RESYNC': {
      if (session) sendWords(session.tab, 'tab', 0);
      if (session?.mic) sendWords(session.mic, 'mic', 0);
      break;
    }
  }
});

async function setMic(enabled: boolean): Promise<void> {
  micWanted = enabled;
  if (!session) return;
  if (enabled) await addMic();
  else removeMic();
}
