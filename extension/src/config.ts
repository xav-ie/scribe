// Small typed wrapper over chrome.storage.sync for user-configurable settings.

export interface Settings {
  /** WebSocket URL of the streaming ASR service, e.g. wss://scribe.lalala.casa/ws */
  wsUrl: string;
  /** Capture the user's microphone alongside the tab audio. */
  withMic: boolean;
  /** Log active-speaker detection + streaming diagnostics to the console. */
  debug: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  wsUrl: 'wss://scribe.lalala.casa/ws',
  withMic: false,
  debug: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}
