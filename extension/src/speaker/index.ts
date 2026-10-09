// Content script: runs in the meeting tab, detects active-speaker changes AND
// the local user's own mute state via the matching platform adapter, and reports
// them: speaker changes to the background worker, which joins them against the
// streamed word timestamps, and mute state straight to the offscreen document,
// which gates the mic stream on it — so all the brittle DOM logic is quarantined
// here and in the adapters.

import { dlog, expose, setDebug } from '../debug';
import type { Message } from '../types';
import { domProbe } from './dom';
import { meetAdapter } from './meet';
import { zoomAdapter } from './zoom';
import type { SpeakerAdapter } from './types';

const ADAPTERS: readonly SpeakerAdapter[] = [meetAdapter, zoomAdapter];
const MAX_PROBES = 6;
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

  const timers: ReturnType<typeof setInterval>[] = [];
  // Reloading the extension cuts this copy off from it: chrome.runtime.id goes
  // undefined and sendMessage throws "Extension context invalidated". Shut down
  // quietly instead of throwing on every tick; starting a recording injects a
  // fresh copy.
  const send = (message: Message): void => {
    if (!chrome.runtime?.id) {
      for (const t of timers) clearInterval(t);
      stopAdapter();
      return;
    }
    chrome.runtime.sendMessage(message).catch(() => {});
  };

  let last: string | null = null;
  const emit = (name: string): void => {
    if (name === last) return;
    last = name;
    dlog('[speaker] active:', name);
    send({
      type: 'SPEAKER_EVENT',
      target: 'background',
      name,
      atEpoch: Date.now(),
    });
  };

  const stopAdapter = adapter.start(emit);

  // Poll the local user's mute state and report changes; the offscreen streams
  // silence (no recording) while muted. null = can't detect → don't gate.
  // Only a frame showing the meeting's participants reports: other frames of
  // the tab can hold mic-labelled controls that aren't the meeting's own.
  let lastMuted: boolean | null = null;
  const reportMuted = (): void => {
    if (adapter.diagnose().tiles === 0) return;
    const muted = adapter.isMuted?.() ?? null;
    if (muted === null || muted === lastMuted) return;
    lastMuted = muted;
    dlog('[speaker] muted:', muted);
    send({ type: 'MUTE_STATE', target: 'offscreen', muted });
  };
  timers.push(setInterval(reportMuted, 500));

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
      if (message.target === 'content' && message.type === 'GET_PARTICIPANTS') {
        const { tiles, names } = adapter.diagnose();
        if (tiles > 0) sendResponse({ names: names.filter((n) => n !== '?') });
      }
    },
  );

  // Debug: dump what the adapter sees every 2s, for selector tuning (only logs
  // when the popup "debug" toggle is on).
  timers.push(
    setInterval(
      () => dlog('[speaker]', adapter.platform, adapter.diagnose()),
      2000,
    ),
  );

  // Snapshot the adapter's view every 10s into the session (the background keeps
  // it only while recording), so debug bundles show what detection saw.
  // While no tiles are found (selectors stale, or the UI moved into a frame),
  // the first few snapshots also carry a page map to re-tune them from.
  // The script runs in every frame of a meeting tab. The top page always
  // reports, so a broken layout leaves a page map (its probe also reads
  // same-origin iframes); an iframe only reports once it has found
  // participants, which keeps the meeting's own frame and silences unrelated
  // ones such as Zoom's chat widget.
  const isTop = globalThis.top === globalThis.self;
  let foundTiles = false;
  let probes = 0;
  const snapshot = (): void => {
    const diag = adapter.diagnose();
    diag.muted = adapter.isMuted?.() ?? null;
    foundTiles ||= diag.tiles > 0;
    if (!isTop && !foundTiles) return;
    if (isTop && diag.tiles === 0 && probes < MAX_PROBES) {
      probes += 1;
      diag.probe = domProbe();
    }
    send({
      type: 'SPEAKER_DIAG',
      target: 'background',
      platform: adapter.platform,
      diag,
      atEpoch: Date.now(),
    });
  };
  timers.push(setInterval(snapshot, 10_000));

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
