import { BUILD, DEFAULT_SETTINGS, getSettings, setSettings } from './config';

const $ = <T extends HTMLElement>(id: string) =>
  document.querySelector(`#${id}`) as T;

const form = $<HTMLFormElement>('form');
const wsUrlInput = $<HTMLInputElement>('wsUrl');
const errorEl = $<HTMLElement>('error');
const savedEl = $<HTMLElement>('saved');

function show(el: HTMLElement, text: string): void {
  errorEl.classList.add('hidden');
  savedEl.classList.add('hidden');
  el.textContent = text;
  el.classList.remove('hidden');
}

/** Host patterns for the WebSocket and the HTTP session API on the same host. */
function originsFor(wsUrl: string): string[] {
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('The URL must start with ws:// or wss://');
  }
  const http = url.protocol === 'ws:' ? 'http:' : 'https:';
  // Match patterns take no port; a pattern covers every port on the host.
  return [`${url.protocol}//${url.hostname}/*`, `${http}//${url.hostname}/*`];
}

// Chrome only grants host access from a user gesture, so the request happens
// here on save rather than when a recording starts.
async function save(wsUrl: string): Promise<void> {
  let origins: string[];
  try {
    origins = originsFor(wsUrl);
  } catch (error) {
    show(errorEl, error instanceof Error ? error.message : String(error));
    return;
  }
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    show(errorEl, `Access to ${new URL(wsUrl).hostname} was not granted.`);
    return;
  }
  await setSettings({ wsUrl });
  show(savedEl, 'Saved.');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void save(wsUrlInput.value.trim());
});

$<HTMLButtonElement>('reset').addEventListener('click', () => {
  wsUrlInput.value = DEFAULT_SETTINGS.wsUrl;
  void save(DEFAULT_SETTINGS.wsUrl);
});

const settings = await getSettings();
wsUrlInput.value = settings.wsUrl;
$<HTMLElement>('build').textContent = BUILD;
