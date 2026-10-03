// Small typed wrapper over chrome.storage.sync for user-configurable settings.

/** Version plus the commit and time it was built from (see manifest.config.ts). */
export const BUILD =
  chrome.runtime.getManifest().version_name ??
  chrome.runtime.getManifest().version;

export interface Settings {
  /** WebSocket URL of the streaming ASR service, e.g. wss://scribe.lalala.casa/ws */
  wsUrl: string;
  /** Capture the user's microphone alongside the tab audio. */
  withMic: boolean;
  /** Log active-speaker detection + streaming diagnostics to the console. */
  debug: boolean;
  /** Ask the streaming service to keep the audio it receives, per session. */
  saveAudio: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  wsUrl: 'wss://scribe.lalala.casa/ws',
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
