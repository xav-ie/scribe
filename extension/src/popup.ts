import { getSettings, setSettings } from './config';
import { getState, onStateChange, type RecState } from './state';
import type { Message, RecordingStatus, TranscriptResponse } from './types';

const $ = <T extends HTMLElement>(id: string) =>
  document.querySelector(`#${id}`) as T;

const LABELS: Record<RecordingStatus, string> = {
  idle: 'Start recording',
  recording: 'Stop recording',
  finalizing: 'Finalizing…',
};

const recordBtn = $<HTMLButtonElement>('record');
const statusEl = $<HTMLSpanElement>('status');
const micToggle = $<HTMLInputElement>('withMic');
const saveRawToggle = $<HTMLInputElement>('saveRaw');
const endpointInput = $<HTMLInputElement>('endpoint');
const micSetupLink = $<HTMLAnchorElement>('micSetup');
const errorEl = $<HTMLElement>('error');
const resultEl = $<HTMLElement>('result');
const transcriptEl = $<HTMLElement>('transcript');

// The popup is a pure reflection of chrome.storage.local state — it never holds
// authoritative status of its own, so closing/reopening it is always accurate.
function render(state: RecState): void {
  statusEl.textContent = state.status;
  statusEl.className = `status ${state.status}`;

  recordBtn.disabled = state.status === 'finalizing';
  recordBtn.textContent = LABELS[state.status];
  recordBtn.classList.toggle('recording', state.status === 'recording');

  if (state.error) {
    errorEl.textContent = state.error;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }

  if (state.transcript && state.transcript.segments.length > 0) {
    renderTranscript(state.transcript);
  } else {
    resultEl.classList.add('hidden');
  }
}

function applyMicPermission(permission: PermissionState): void {
  const granted = permission === 'granted';
  micSetupLink.textContent = granted ? 'access granted ✓' : 'grant access';
  micSetupLink.classList.toggle('granted', granted);
}

async function trackMicPermission(): Promise<void> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    applyMicPermission(status.state);
    // Update live if it's granted/revoked in another tab while the popup is open.
    status.addEventListener('change', () => applyMicPermission(status.state));
  } catch {
    // permissions.query may not support "microphone" everywhere; leave default.
  }
}

async function init(): Promise<void> {
  const settings = await getSettings();
  micToggle.checked = settings.withMic;
  saveRawToggle.checked = settings.saveRaw;
  endpointInput.value = settings.endpoint;

  render(await getState());
  onStateChange(render);
  await trackMicPermission();
}

recordBtn.addEventListener('click', () => {
  // Buttons only send commands; the resulting state change re-renders the UI.
  if (recordBtn.classList.contains('recording')) {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING',
      target: 'background',
    } satisfies Message);
  } else if (!recordBtn.disabled) {
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      target: 'background',
    } satisfies Message);
  }
});

micToggle.addEventListener(
  'change',
  () => void setSettings({ withMic: micToggle.checked }),
);
saveRawToggle.addEventListener(
  'change',
  () => void setSettings({ saveRaw: saveRawToggle.checked }),
);
endpointInput.addEventListener(
  'change',
  () => void setSettings({ endpoint: endpointInput.value.trim() }),
);

micSetupLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/micsetup.html') });
});

function renderTranscript(t: TranscriptResponse): void {
  transcriptEl.replaceChildren();
  for (const seg of t.segments) {
    const div = document.createElement('div');
    div.className = 'seg';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = seg.speaker;

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `${seg.start.toFixed(1)}s`;

    const text = document.createElement('span');
    text.textContent = seg.text;

    div.append(who, ts, text);
    transcriptEl.append(div);
  }
  resultEl.classList.remove('hidden');
}

await init();
