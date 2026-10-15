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
import { applyWords, type Word } from './transcript';

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
  /** Called when the server has sent its last words (or the socket closed). */
  flushed: (() => void) | null;
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

// Each meeting tab's last reported mute state. While the captured tab's is
// true, the mic streams silence: you're muted, so it isn't recorded. Keyed by
// tab because every meeting tab reports (a second Meet tab with its mic off
// must not silence this one), and kept outside the session so a report that
// lands before start() knows its tab isn't lost.
const mutedByTab = new Map<number, boolean>();
// Each meeting tab's mic as the page opened it, by label (device ids differ per
// origin; labels don't). The recording's mic opens the captured tab's, and
// follows it when the meeting switches mics.
const meetingMicByTab = new Map<number, string>();
let micOpenedFor: string | undefined;
const SILENT_MIC_SECONDS = 20;
// How long a stopped stream waits for the server's last words.
const FLUSH_TIMEOUT_MS = 5000;
let captureTabId: number | null = null;
const micMuted = (): boolean =>
  captureTabId !== null && mutedByTab.get(captureTabId) === true;

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
// The device is the meeting's own mic when it's known, else the system default
// ('default'). Both are `exact`: an unset or merely preferred deviceId lets
// Chrome pick the top of its own ranking of mics chosen in sites before, which
// can be a virtual device (BlackHole) that's silent unless something feeds it.
async function micDeviceId(label: string | undefined): Promise<string> {
  if (!label) return 'default';
  const devices = await navigator.mediaDevices.enumerateDevices();
  return (
    devices.find((d) => d.kind === 'audioinput' && d.label === label)
      ?.deviceId ?? 'default'
  );
}

const openMic = (deviceId: string): Promise<MediaStream> =>
  navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

async function openMicStream(
  label: string | undefined,
): Promise<MediaStream | null> {
  try {
    const deviceId = await micDeviceId(label);
    // The meeting's mic can be unplugged between its report and now.
    return await openMic(deviceId).catch((error: unknown) => {
      if (deviceId === 'default') throw error;
      return openMic('default');
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
    flushed: null,
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
      // Words keep coming after a stop, while the server decodes what it holds.
      if (msg.type === 'done') channel.flushed?.();
      if (msg.type !== 'words') return;
      const from = msg.from ?? 0;
      if (!applyWords(channel.words, from, msg.words ?? [])) {
        console.warn('[offscreen] word update past the end', from);
        return;
      }
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
      void teardown();
    } else {
      console.warn('[offscreen] mic stream error; dropping mic');
      removeMic();
    }
  });
  ws.addEventListener('close', () => {
    channel.flushed?.();
    if (channel.closing) return; // deliberate (stop / mic toggled off)
    if (primary) {
      if (session) sendState({ status: 'idle' });
      void teardown();
    } else {
      removeMic();
    }
  });

  // Samples of unbroken digital silence from the mic while not muted: a device
  // that delivers nothing (wrong input, or an OS-level mute), not a quiet room,
  // which still carries noise.
  let zeroSamples = 0;
  let warnedSilent = false;

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
    const gated = channelName === 'mic' && micMuted();
    const pcm = gated ? new Int16Array(data.length).buffer : floatToInt16(data);
    ws.send(pcm);
    if (channelName === 'mic' && !gated && !warnedSilent) {
      zeroSamples = data.every((x) => x === 0) ? zeroSamples + data.length : 0;
      if (zeroSamples >= ctx.sampleRate * SILENT_MIC_SECONDS) {
        warnedSilent = true;
        const device = session.micStream?.getAudioTracks()[0]?.label;
        const which = device ? ` (${device})` : '';
        sendState({
          warning: `Your microphone${which} is sending pure silence, so your voice isn't being transcribed. Check the input device in your system settings, then restart the recording.`,
        });
      }
    }
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

// Stop feeding a channel and close its socket. With `flush`, first ask the
// server for the words it still holds (the audio short of a step and its
// lookahead) and wait for them, up to FLUSH_TIMEOUT_MS.
async function closeChannel(ch: Channel, flush = false): Promise<void> {
  ch.closing = true;
  try {
    ch.node.disconnect();
    ch.source.disconnect();
  } catch {
    /* already gone */
  }
  if (flush && ch.ws.readyState === WebSocket.OPEN) {
    await new Promise<void>((resolve) => {
      ch.flushed = resolve;
      setTimeout(resolve, FLUSH_TIMEOUT_MS);
      ch.ws.send(JSON.stringify({ type: 'end' }));
    });
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
  const label =
    captureTabId === null ? undefined : meetingMicByTab.get(captureTabId);
  const micStream = await openMicStream(label).finally(() => {
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
  micOpenedFor = label;
  const track = micStream.getAudioTracks()[0];
  const settings = track?.getSettings() ?? {};
  sendState({
    micDevice: `${track?.label || 'unknown device'} (${JSON.stringify({
      deviceId: settings.deviceId,
      groupId: settings.groupId,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation,
      muted: track?.muted,
      readyState: track?.readyState,
    })})`,
  });
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
  void closeChannel(session.mic, true);
  for (const t of session.micStream?.getTracks() ?? []) t.stop();
  session.mic = null;
  session.micStream = null;
  micOpenedFor = undefined;
  console.log('[offscreen] mic removed');
}

async function start(
  opts: StreamOpts & { streamId: string; withMic: boolean; tabId: number },
): Promise<void> {
  if (session) return;
  const gen = ++generation;
  captureTabId = opts.tabId;
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
    if (session) void teardown();
    else release();
    const message = error instanceof Error ? error.message : String(error);
    console.error('[offscreen] start failed:', message);
    sendState({ status: 'idle', error: message });
  }
}

// Idle is reported once the server's last words are in, so the background
// finishes the session with them.
async function stop(): Promise<void> {
  generation++;
  if (!session) return;
  console.log('[offscreen] stop requested');
  await teardown(true);
  sendState({ status: 'idle' });
}

async function teardown(flush = false): Promise<void> {
  generation++; // a start still in flight must not report "recording"
  // The offscreen doc outlives recordings; the next one starts unmuted unless
  // the content script reports otherwise (it does just before each start).
  mutedByTab.clear();
  meetingMicByTab.clear();
  captureTabId = null;
  if (!session) return;
  const s = session;
  session = null; // null first so the close handlers don't re-enter
  const closing = [closeChannel(s.tab, flush)];
  if (s.mic) closing.push(closeChannel(s.mic, flush));
  for (const t of s.tabStream.getTracks()) t.stop();
  for (const t of s.micStream?.getTracks() ?? []) t.stop();
  s.ctx.close().catch(() => {});
  await Promise.all(closing);
}

chrome.runtime.onMessage.addListener((message: Message, sender) => {
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
    case 'MEETING_MIC': {
      const tab = sender.tab?.id;
      if (tab === undefined) break;
      meetingMicByTab.set(tab, message.label);
      // The meeting switched mics mid-recording: follow it.
      if (
        tab === captureTabId &&
        session?.mic &&
        micOpenedFor !== message.label
      ) {
        removeMic();
        void addMic();
      }
      break;
    }
    case 'MUTE_STATE': {
      if (sender.tab?.id !== undefined)
        mutedByTab.set(sender.tab.id, message.muted);
      break;
    }
    case 'OFFSCREEN_STOP': {
      void stop();
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
