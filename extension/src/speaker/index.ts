// Content script: runs in the meeting tab, detects active-speaker changes via
// the matching platform adapter, and reports them to the background worker. The
// background joins these against the streamed word timestamps to produce a
// speaker-attributed transcript (see transcript.ts) — so all the brittle DOM
// logic is quarantined here and in the adapters.

import { dlog, expose, setDebug } from '../debug';
import type { Message } from '../types';
import { meetAdapter } from './meet';
import { zoomAdapter } from './zoom';
import type { SpeakerAdapter } from './types';

const ADAPTERS: readonly SpeakerAdapter[] = [meetAdapter, zoomAdapter];
const adapter = ADAPTERS.find((a) => a.matches(location.host));

if (adapter) {
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

  // A fresh recording resets the timeline; re-emit the current speaker so it's
  // seeded from the first word (force past the dedupe by clearing `last`).
  chrome.runtime.onMessage.addListener((message: Message) => {
    if (message.target === 'content' && message.type === 'RESET_SPEAKER') {
      const current = last;
      last = null;
      if (current) emit(current);
    }
  });

  // Debug: dump what the adapter sees every 2s, for selector tuning (only logs
  // when the popup "debug" toggle is on).
  setInterval(
    () => dlog('[speaker]', adapter.platform, adapter.diagnose()),
    2000,
  );

  // Console test API (run in the meeting tab; if it's undefined in the console,
  // switch the console's JS context to this content script):
  //   speakerProbe.diagnose()    tiles/names the adapter currently sees
  //   speakerProbe.current()     last detected speaker
  //   speakerProbe.emit('Bob')   manually fire a speaker change
  expose('speakerProbe', {
    diagnose: () => adapter.diagnose(),
    current: () => last,
    emit: (name: string) => emit(name),
  });

  console.log(
    `[speaker] active-speaker observer running for ${adapter.platform}`,
  );
}
