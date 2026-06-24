// Small typed wrapper over chrome.storage.sync for user-configurable settings.

export interface Settings {
  /** Full URL of the transcription endpoint, e.g. http://localhost:8000/transcribe */
  endpoint: string;
  /** Capture the user's microphone alongside the tab audio. */
  withMic: boolean;
  /** Also save the raw .webm locally via chrome.downloads-style blob URL (debug). */
  saveRaw: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  endpoint: 'https://whisperx.lalala.casa/transcribe',
  withMic: false,
  saveRaw: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}
