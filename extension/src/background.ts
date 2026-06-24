// Service worker: orchestrates capture. It owns no audio itself — it brokers a
// tab MediaStream id to the offscreen document. Durable status lives in
// chrome.storage.local (state.ts), so it survives this worker being torn down.

import { getSettings } from './config';
import { getState, setState } from './state';
import type { Message } from './types';

const OFFSCREEN_PATH = 'src/offscreen.html';

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
    // USER_MEDIA: getUserMedia for the tab/mic streams.
    // AUDIO_PLAYBACK: we re-route tab audio to speakers so it isn't muted.
    reasons: [
      'USER_MEDIA' as chrome.offscreen.Reason,
      'AUDIO_PLAYBACK' as chrome.offscreen.Reason,
    ],
    justification: 'Record meeting tab audio for transcription.',
  });
}

async function startRecording(): Promise<void> {
  const { status } = await getState();
  if (status !== 'idle') return;

  // Optimistic, so a double-click can't start two captures. The offscreen doc
  // reaffirms 'recording' once the stream is actually open.
  await setState({
    status: 'recording',
    transcript: undefined,
    error: undefined,
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await setState({ status: 'idle', error: 'No active tab to capture.' });
    return;
  }

  const settings = await getSettings();

  // Must be obtained in the (gesture-backed) service worker, then handed to the
  // offscreen doc which actually opens the stream.
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
      endpoint: settings.endpoint,
      saveRaw: settings.saveRaw,
    } satisfies Message)
    .catch(() => {});
}

async function stopRecording(): Promise<void> {
  const { status } = await getState();
  if (status !== 'recording') return;
  await setState({ status: 'finalizing' });
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_STOP',
      target: 'offscreen',
    } satisfies Message)
    .catch(() => {});
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
      // Offscreen doc can't write storage; it delegates the transition to us.
      setState(message.patch).catch(() => {});
      break;
    }
  }
});

// Drop stale state on extension reload / browser restart: if storage says we're
// mid-capture but the offscreen context is gone, nothing is actually recording —
// reset so the popup isn't stuck on "recording"/"finalizing". (When a real
// capture is in flight the offscreen doc still exists, so this leaves it alone.)
// Registered as listeners, NOT a top-level await — MV3 service workers forbid
// top-level await.
async function reconcileStaleState(): Promise<void> {
  const { status } = await getState();
  if (status !== 'idle' && !(await hasOffscreenDocument())) {
    await setState({ status: 'idle' });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  reconcileStaleState().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  reconcileStaleState().catch(() => {});
});
