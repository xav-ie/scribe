// Service worker: orchestrates capture. It owns no audio itself — it brokers a
// tab MediaStream id to the offscreen document and tracks recording state.

import { getSettings } from './config';
import type { Message, RecordingStatus } from './types';

const OFFSCREEN_PATH = 'src/offscreen.html';

let status: RecordingStatus = 'idle';

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
  if (status !== 'idle') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    notifyPopup({
      type: 'RECORDING_ERROR',
      target: 'popup',
      error: 'No active tab to capture.',
    });
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

  status = 'recording';
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    target: 'offscreen',
    streamId,
    withMic: settings.withMic,
    endpoint: settings.endpoint,
    saveRaw: settings.saveRaw,
  } satisfies Message);
}

function stopRecording(): void {
  if (status !== 'recording') return;
  status = 'finalizing';
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_STOP',
    target: 'offscreen',
  } satisfies Message);
}

function notifyPopup(msg: Message): void {
  // Popup may be closed; ignore the "no receiver" rejection.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    switch (message.type) {
      case 'START_RECORDING': {
        startRecording().catch((error) => {
          status = 'idle';
          notifyPopup({
            type: 'RECORDING_ERROR',
            target: 'popup',
            error: error instanceof Error ? error.message : String(error),
          });
        });
        break;
      }
      case 'STOP_RECORDING': {
        stopRecording();
        break;
      }
      case 'GET_STATE': {
        sendResponse({ status });
        return true;
      }
      // Status transitions reported by the offscreen document.
      case 'RECORDING_ERROR': {
        status = 'idle';
        break;
      }
      case 'TRANSCRIPT_READY': {
        status = 'idle';
        break;
      }
      case 'RECORDING_FINALIZING': {
        status = 'finalizing';
        break;
      }
    }
  },
);
