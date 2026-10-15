import logo from '../../assets/logo/scribe.svg';
import {
  BUILD,
  getSettings,
  grantServerAccess,
  saveServerUrl,
  serverOrigins,
} from './config';

const $ = <T extends HTMLElement>(id: string) =>
  document.querySelector(`#${id}`) as T;

const form = $<HTMLFormElement>('form');
const wsUrlInput = $<HTMLInputElement>('wsUrl');
const accessEl = $<HTMLElement>('access');
const accessHostEl = $<HTMLElement>('accessHost');
const errorEl = $<HTMLElement>('error');
const savedEl = $<HTMLElement>('saved');

$<HTMLImageElement>('logo').src = logo;

function show(el: HTMLElement | null, text = ''): void {
  for (const box of [errorEl, savedEl]) box.classList.add('hidden');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
}

// The server waiting for the user to allow its host, if any.
let pending: { wsUrl: string; origins: string[] } | null = null;

function askForAccess(wsUrl: string, host: string, origins: string[]): void {
  pending = { wsUrl, origins };
  accessHostEl.textContent = host;
  accessEl.classList.remove('hidden');
}

function closeAccess(): void {
  pending = null;
  accessEl.classList.add('hidden');
}

async function save(wsUrl: string): Promise<void> {
  const result = await saveServerUrl(wsUrl);
  if (result.status === 'saved') show(savedEl, 'Saved.');
  else if (result.status === 'invalid') show(errorEl, result.error);
  else {
    show(null);
    askForAccess(wsUrl, result.host, result.origins);
  }
}

// Chrome only shows its permission prompt from a click, so the request is the
// first thing this button's handler awaits.
async function grant(): Promise<void> {
  if (!pending) return;
  const { wsUrl, origins } = pending;
  const error = await grantServerAccess(wsUrl, origins);
  closeAccess();
  if (error) show(errorEl, `${error} The server was not saved.`);
  else show(savedEl, 'Access allowed. Saved.');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  closeAccess();
  void save(wsUrlInput.value.trim());
});

$<HTMLButtonElement>('grant').addEventListener('click', () => void grant());

$<HTMLButtonElement>('cancel').addEventListener('click', () => {
  closeAccess();
  show(errorEl, 'Not saved: the extension needs access to reach the server.');
});

const settings = await getSettings();
wsUrlInput.value = settings.wsUrl;
$<HTMLElement>('build').textContent = BUILD;

// A saved server whose access was since removed (chrome://extensions) can't be
// reached until it's allowed again.
if (settings.wsUrl) {
  const origins = serverOrigins(settings.wsUrl);
  if (!(await chrome.permissions.contains({ origins }))) {
    askForAccess(settings.wsUrl, new URL(settings.wsUrl).hostname, origins);
  }
}
