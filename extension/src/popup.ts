import mark from '../../assets/logo/mark.svg';
import { BUILD, getSettings, setSettings } from './config';
import {
  getState,
  JOIN_SESSION_KEY,
  onStateChange,
  type RecState,
} from './state';
import type { Message, RecordingStatus } from './types';
import type { Segment } from './transcript';

const $ = <T extends HTMLElement>(id: string) =>
  document.querySelector(`#${id}`) as T;

const LABELS: Record<RecordingStatus, string> = {
  idle: 'Start recording',
  recording: 'Stop recording',
};

const UNKNOWN = 'Unknown';

$<HTMLElement>('mark').style.backgroundImage = `url(${mark})`;
const recordBtn = $<HTMLButtonElement>('record');
const statusEl = $<HTMLSpanElement>('status');
const debugToggle = $<HTMLInputElement>('debug');
const saveAudioToggle = $<HTMLInputElement>('saveAudio');
const saveAudioNote = $<HTMLElement>('saveAudioNote');
const exportBtn = $<HTMLButtonElement>('exportDebug');
const micSetupLink = $<HTMLAnchorElement>('micSetup');
const errorEl = $<HTMLElement>('error');
const warningEl = $<HTMLElement>('warning');
const insecureEl = $<HTMLElement>('insecure');
const resultEl = $<HTMLElement>('result');
const speakersEl = $<HTMLElement>('speakers');
const transcriptEl = $<HTMLElement>('transcript');

// The popup is a pure reflection of chrome.storage.local state — it never holds
// authoritative status of its own, so closing/reopening it is always accurate.
function render(state: RecState): void {
  statusEl.textContent = state.status;
  statusEl.className = `status ${state.status}`;

  recordBtn.textContent = LABELS[state.status];
  recordBtn.classList.toggle('recording', state.status === 'recording');
  // The streaming service is told whether to save audio when a stream opens,
  // so a change only applies from the next recording.
  saveAudioToggle.disabled = state.status !== 'idle';
  saveAudioNote.classList.toggle('hidden', state.status === 'idle');

  if (state.error) {
    errorEl.textContent = state.error;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }
  warningEl.textContent = state.warning ?? '';
  warningEl.classList.toggle('hidden', !state.warning);
  insecureEl.classList.toggle('hidden', !state.insecure);

  if (state.segments && state.segments.length > 0) {
    renderSegments(state.segments);
  } else if (state.rawText) {
    renderRaw(state.rawText);
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
    status.addEventListener('change', () => applyMicPermission(status.state));
  } catch {
    // permissions.query may not support "microphone" everywhere; leave default.
  }
}

async function init(): Promise<void> {
  const settings = await getSettings();
  debugToggle.checked = settings.debug;
  saveAudioToggle.checked = settings.saveAudio;
  $<HTMLElement>('build').textContent = BUILD;

  render(await getState());
  onStateChange(render);
  chrome.runtime
    .sendMessage({
      type: 'RETRY_UPLOADS',
      target: 'background',
    } satisfies Message)
    .catch(() => {});
  await trackMicPermission();
}

recordBtn.addEventListener('click', () => {
  const type = recordBtn.classList.contains('recording')
    ? 'STOP_RECORDING'
    : 'START_RECORDING';
  chrome.runtime.sendMessage({ type, target: 'background' } satisfies Message);
});

debugToggle.addEventListener(
  'change',
  () => void setSettings({ debug: debugToggle.checked }),
);
saveAudioToggle.addEventListener(
  'change',
  () => void setSettings({ saveAudio: saveAudioToggle.checked }),
);
$<HTMLAnchorElement>('openOptions').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage().catch(() => {});
});

// Everything needed to diagnose the last recording in one file: the transcript,
// the join inputs (speaker timeline, per-stream words and clocks, adapter
// snapshots) and the settings it ran with. The sessionId matches the audio the
// streaming service saved, if "save audio" was on.
async function exportDebugBundle(): Promise<void> {
  const [settings, recState, stored] = await Promise.all([
    getSettings(),
    getState(),
    chrome.storage.local.get(JOIN_SESSION_KEY),
  ]);
  const session = stored[JOIN_SESSION_KEY] as
    { sessionId?: string | null } | undefined;
  const bundle = {
    exportedAt: new Date().toISOString(),
    extensionVersion: BUILD,
    settings,
    recState,
    session: session ?? null,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `meeting-capture-${session?.sessionId ?? Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener('click', () => void exportDebugBundle());

// The grant lives on the settings page.
micSetupLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage().catch(() => {});
});

// Deterministic per-speaker colour so each person reads consistently across the
// legend and the script. Light enough for 4.5:1 on the popup's browns at any hue.
function speakerColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 75% 82%)`;
}

// Whether the transcript is scrolled to (near) the bottom — used to keep it
// pinned to the newest line as it streams in, without fighting a manual scroll-up.
function nearBottom(): boolean {
  return (
    resultEl.scrollHeight - resultEl.scrollTop - resultEl.clientHeight < 40
  );
}

// Speaker-attributed transcript, rendered like a play script: a coloured speaker
// header per turn, their line beneath, plus a legend of everyone detected.
function renderSegments(segments: readonly Segment[]): void {
  const stick = nearBottom();

  const names = [...new Set(segments.map((s) => s.speaker))];
  const shown = names.filter((n) => n !== UNKNOWN);
  speakersEl.replaceChildren();
  for (const name of shown.length > 0 ? shown : names) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = name;
    chip.style.setProperty('--c', speakerColor(name));
    speakersEl.append(chip);
  }

  transcriptEl.replaceChildren();
  for (const seg of segments) {
    const turn = document.createElement('div');
    turn.className = 'turn';

    const who = document.createElement('div');
    who.className = 'speaker';
    who.textContent = seg.speaker;
    who.style.color = speakerColor(seg.speaker);

    const line = document.createElement('div');
    line.className = 'line';
    line.textContent = seg.text;

    turn.append(who, line);
    transcriptEl.append(turn);
  }

  resultEl.classList.remove('hidden');
  if (stick) resultEl.scrollTop = resultEl.scrollHeight;
}

// Before any speaker events arrive there's nothing to attribute — show the raw
// running transcript so you can see the stream is working.
function renderRaw(text: string): void {
  speakersEl.replaceChildren();
  transcriptEl.replaceChildren();
  const div = document.createElement('div');
  div.className = 'raw';
  div.textContent = text;
  transcriptEl.append(div);
  resultEl.classList.remove('hidden');
  resultEl.scrollTop = resultEl.scrollHeight;
}

await init();
