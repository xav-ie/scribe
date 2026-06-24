import { getSettings, setSettings } from './config';
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
const resultEl = $<HTMLElement>('result');
const transcriptEl = $<HTMLElement>('transcript');

let status: RecordingStatus = 'idle';

function render(): void {
  statusEl.textContent = status;
  statusEl.className = `status ${status}`;

  recordBtn.disabled = status === 'finalizing';
  recordBtn.textContent = LABELS[status];
  recordBtn.classList.toggle('recording', status === 'recording');
}

function setStatus(next: RecordingStatus): void {
  status = next;
  render();
}

async function init(): Promise<void> {
  const settings = await getSettings();
  micToggle.checked = settings.withMic;
  saveRawToggle.checked = settings.saveRaw;
  endpointInput.value = settings.endpoint;

  const state = (await chrome.runtime.sendMessage({
    type: 'GET_STATE',
    target: 'background',
  } satisfies Message)) as { status: RecordingStatus } | undefined;
  setStatus(state?.status ?? 'idle');
}

recordBtn.addEventListener('click', () => {
  if (status === 'recording') {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING',
      target: 'background',
    } satisfies Message);
    setStatus('finalizing');
  } else if (status === 'idle') {
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

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.target !== 'popup') return;
  switch (message.type) {
    case 'RECORDING_STARTED': {
      setStatus('recording');
      break;
    }
    case 'RECORDING_FINALIZING': {
      setStatus('finalizing');
      break;
    }
    case 'RECORDING_ERROR': {
      setStatus('idle');
      console.error('[popup]', message.error);
      statusEl.textContent = 'error';
      statusEl.title = message.error;
      break;
    }
    case 'TRANSCRIPT_READY': {
      setStatus('idle');
      renderTranscript(message.transcript);
      break;
    }
  }
});

await init();
