import { BUILD, getSettings, saveServerUrl } from './config';

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

// Chrome only grants host access from a user gesture, so the request happens
// here on save rather than when a recording starts.
async function save(wsUrl: string): Promise<void> {
  const error = await saveServerUrl(wsUrl);
  if (error) show(errorEl, error);
  else show(savedEl, 'Saved.');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void save(wsUrlInput.value.trim());
});

const settings = await getSettings();
wsUrlInput.value = settings.wsUrl;
$<HTMLElement>('build').textContent = BUILD;
