// Small typed wrapper over chrome.storage.sync for user-configurable settings.

/** Version plus the commit and time it was built from (see manifest.config.ts). */
export const BUILD =
  chrome.runtime.getManifest().version_name ??
  chrome.runtime.getManifest().version;

export interface Settings {
  /** WebSocket URL of the scribe server, set on the options page. Empty until then. */
  wsUrl: string;
  /** Log active-speaker detection + streaming diagnostics to the console. */
  debug: boolean;
  /** Ask the streaming service to keep the audio it receives, per session. */
  saveAudio: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  wsUrl: '',
  debug: false,
  saveAudio: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get<Settings>(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/**
 * The server URL as saved, split into the WebSocket URL and the access token
 * from its `#token=…` part (the web UI's Pair page gives that form). WebSocket
 * URLs can't carry a fragment, so the token travels in the first message.
 */
export function splitServerUrl(wsUrl: string): { url: string; token?: string } {
  const url = new URL(wsUrl);
  const token =
    new URLSearchParams(url.hash.slice(1)).get('token') || undefined;
  url.hash = '';
  return { url: url.href, token };
}

/** The server URL with its token replaced, for anything that may be shared. */
export function redactToken(wsUrl: string): string {
  if (!wsUrl) return wsUrl;
  const { url, token } = splitServerUrl(wsUrl);
  return token ? `${url}#token=redacted` : url;
}

/** The server's HTTP API at `path`, on the same host as its WebSocket. */
export function apiUrl(wsUrl: string, path: string): URL {
  const url = new URL(path, splitServerUrl(wsUrl).url);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  return url;
}

/** Headers for the server's HTTP API: the token, when there is one. */
export function apiHeaders(wsUrl: string): Record<string, string> {
  const { token } = splitServerUrl(wsUrl);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Host patterns for the WebSocket and the HTTP session API on the same host. */
export function serverOrigins(wsUrl: string): string[] {
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('The URL must start with ws:// or wss://');
  }
  const http = url.protocol === 'ws:' ? 'http:' : 'https:';
  // Match patterns take no port; a pattern covers every port on the host.
  return [`${url.protocol}//${url.hostname}/*`, `${http}//${url.hostname}/*`];
}

/**
 * What the server says about this URL: `ok` (its token is right), `open` (it
 * has no token at all), `needs-token` (it wants one and the URL carries none),
 * `bad-token` (it refuses this one), or `unreachable` (no usable answer).
 */
export type ServerCheck =
  'ok' | 'open' | 'needs-token' | 'bad-token' | 'unreachable';

export async function checkServer(wsUrl: string): Promise<ServerCheck> {
  try {
    const signal = AbortSignal.timeout(5000);
    const info = await fetch(apiUrl(wsUrl, '/api/info'), { signal });
    if (!info.ok) return 'unreachable';
    const { auth } = (await info.json()) as { auth?: boolean };
    if (!auth) return 'open';
    if (!splitServerUrl(wsUrl).token) return 'needs-token';
    // Any route behind the token tells whether it's the right one.
    const probe = await fetch(apiUrl(wsUrl, '/api/vocab'), {
      headers: apiHeaders(wsUrl),
      signal,
    });
    return probe.status === 401 ? 'bad-token' : 'ok';
  } catch {
    return 'unreachable';
  }
}

export type SaveResult =
  /** Saved; `server` is what the server said, for the page to report. */
  | { status: 'saved'; server: ServerCheck }
  | { status: 'invalid'; error: string }
  /** Chrome hasn't granted access to the server's host yet: ask the user. */
  | { status: 'needs-access'; host: string; origins: string[] };

const TOKEN_HELP =
  "Copy the server's URL from its web UI (log in, then pair extension).";

// The URL can reach its host: check it against the server, then save it unless
// the server would refuse it.
async function checkAndSave(wsUrl: string): Promise<SaveResult> {
  const server = await checkServer(wsUrl);
  if (server === 'needs-token') {
    return {
      status: 'invalid',
      error: `This server needs its access token, and this URL has none. ${TOKEN_HELP}`,
    };
  }
  if (server === 'bad-token') {
    return {
      status: 'invalid',
      error: `This server doesn't accept the token in this URL. ${TOKEN_HELP}`,
    };
  }
  await setSettings({ wsUrl });
  return { status: 'saved', server };
}

/** Save the server if the extension may already reach its host. */
export async function saveServerUrl(wsUrl: string): Promise<SaveResult> {
  let origins: string[];
  try {
    origins = serverOrigins(wsUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'invalid', error: message };
  }
  if (!(await chrome.permissions.contains({ origins }))) {
    return { status: 'needs-access', host: new URL(wsUrl).hostname, origins };
  }
  return checkAndSave(wsUrl);
}

/**
 * Ask Chrome for access to the server's host, then check and save it. Chrome
 * only asks during a user gesture, so call this straight from the click that
 * asks for it: the request comes before any await.
 */
export async function grantServerAccess(
  wsUrl: string,
  origins: string[],
): Promise<SaveResult> {
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    return {
      status: 'invalid',
      error: `Access to ${new URL(wsUrl).hostname} was not granted.`,
    };
  }
  return checkAndSave(wsUrl);
}
