// Content script: runs in the meeting tab, detects active-speaker changes AND
// the local user's own mute state via the matching platform adapter, and reports
// them: speaker changes to the background worker, which joins them against the
// streamed word timestamps, and mute state straight to the offscreen document,
// which gates the mic stream on it — so all the brittle DOM logic is quarantined
// here and in the adapters.

import { dlog, expose, setDebug } from '../debug';
import type { Message } from '../types';
import { meetAdapter } from './meet';
import { zoomAdapter } from './zoom';
import type { SpeakerAdapter } from './types';

const ADAPTERS: readonly SpeakerAdapter[] = [meetAdapter, zoomAdapter];
const adapter = ADAPTERS.find((a) => a.matches(location.host));

// CRXJS's loader imports this module, which runs once per page context, then
// calls onExecute on every injection. Setup lives there so the background can
// re-inject into a tab whose earlier copy was orphaned by an extension reload
// (see startSpeakerDetection).
export function onExecute(): void {
  if (adapter) start(adapter);
}

function start(adapter: SpeakerAdapter): void {
  // Callback form (not the promise) — content scripts run as classic scripts
  // with no top-level await, and this avoids a floating promise chain.
  chrome.storage.sync.get({ debug: false }, (s) => setDebug(Boolean(s.debug)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.debug)
      setDebug(Boolean(changes.debug.newValue));
  });

  let last: string | null = null;
  const emit = (name: string): void => {
    if (name === last) return;
    last = name;
    dlog('[speaker] active:', name);
    chrome.runtime
      .sendMessage({
        type: 'SPEAKER_EVENT',
        target: 'background',
        name,
        atEpoch: Date.now(),
      } satisfies Message)
      .catch(() => {});
  };

  adapter.start(emit);

  // Poll the local user's mute state and report changes; the offscreen streams
  // silence (no recording) while muted. null = can't detect → don't gate.
  let lastMuted: boolean | null = null;
  const reportMuted = (): void => {
    const muted = adapter.isMuted?.() ?? null;
    if (muted === null || muted === lastMuted) return;
    lastMuted = muted;
    dlog('[speaker] muted:', muted);
    chrome.runtime
      .sendMessage({
        type: 'MUTE_STATE',
        target: 'offscreen',
        muted,
      } satisfies Message)
      .catch(() => {});
  };
  setInterval(reportMuted, 500);

  // A fresh recording resets the timeline; re-emit the current speaker + mute
  // state so both are seeded from the start (force past the dedupe). Mute is
  // reported immediately, before the mic stream finishes opening.
  // The reply tells the background this script is alive in the captured tab.
  chrome.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse) => {
      if (message.target === 'content' && message.type === 'RESET_SPEAKER') {
        const current = last;
        last = null;
        lastMuted = null;
        reportMuted();
        if (current) emit(current);
        sendResponse({ platform: adapter.platform });
      }
    },
  );

  // Debug: dump what the adapter sees every 2s, for selector tuning (only logs
  // when the popup "debug" toggle is on).
  setInterval(
    () => dlog('[speaker]', adapter.platform, adapter.diagnose()),
    2000,
  );

  // Snapshot the adapter's view every 10s into the session (the background keeps
  // it only while recording), so debug bundles show what detection saw.
  setInterval(() => {
    chrome.runtime
      .sendMessage({
        type: 'SPEAKER_DIAG',
        target: 'background',
        platform: adapter.platform,
        diag: adapter.diagnose(),
        atEpoch: Date.now(),
      } satisfies Message)
      .catch(() => {});
  }, 10_000);

  // Console test API (run in the meeting tab; if it's undefined in the console,
  // switch the console's JS context to this content script):
  //   speakerProbe.diagnose()    tiles/names the adapter currently sees
  //   speakerProbe.muted()       current detected mute state
  //   speakerProbe.emit('Bob')   manually fire a speaker change
  expose('speakerProbe', {
    diagnose: () => adapter.diagnose(),
    muted: () => adapter.isMuted?.() ?? null,
    emit: (name: string) => emit(name),
  });

  console.log(
    `[speaker] active-speaker observer running for ${adapter.platform}`,
  );
}
