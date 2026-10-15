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

/**
 * Point the extension at another server: ask for access to its host, then save
 * it. Resolves to why it wasn't saved, or null. Chrome only grants host access
 * during a user gesture, so call this straight from one (nothing is awaited
 * before the request).
 */
export async function saveServerUrl(wsUrl: string): Promise<string | null> {
  let origins: string[];
  try {
    origins = serverOrigins(wsUrl);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const granted = await chrome.permissions.request({ origins });
  if (!granted) return `Access to ${new URL(wsUrl).hostname} was not granted.`;
  await setSettings({ wsUrl });
  return null;
}
