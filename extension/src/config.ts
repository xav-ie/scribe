// Small typed wrapper over chrome.storage.sync for user-configurable settings.

/** Version plus the commit and time it was built from (see manifest.config.ts). */
export const BUILD =
  chrome.runtime.getManifest().version_name ??
  chrome.runtime.getManifest().version;

export interface Settings {
  /** WebSocket URL of the scribe server, set on the options page. Empty until then. */
  wsUrl: string;
  /** Capture the user's microphone alongside the tab audio. */
  withMic: boolean;
  /** Log active-speaker detection + streaming diagnostics to the console. */
  debug: boolean;
  /** Ask the streaming service to keep the audio it receives, per session. */
  saveAudio: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  wsUrl: '',
  withMic: false,
  debug: false,
  saveAudio: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
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

export type SaveResult =
  | { status: 'saved' }
  | { status: 'invalid'; error: string }
  /** Chrome hasn't granted access to the server's host yet: ask the user. */
  | { status: 'needs-access'; host: string; origins: string[] };

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
  await setSettings({ wsUrl });
  return { status: 'saved' };
}

/**
 * Ask Chrome for access to the server's host, then save it. Resolves to why it
 * wasn't saved, or null. Chrome only asks during a user gesture, so call this
 * straight from the click that asks for it: the request comes before any await.
 */
export async function grantServerAccess(
  wsUrl: string,
  origins: string[],
): Promise<string | null> {
  const granted = await chrome.permissions.request({ origins });
  if (!granted) return `Access to ${new URL(wsUrl).hostname} was not granted.`;
  await setSettings({ wsUrl });
  return null;
}
