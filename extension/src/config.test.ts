import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveServerUrl,
  serverOrigins,
} from './config';
import { chromeStub } from './test/chrome';

describe('serverOrigins', () => {
  it('covers the socket and the HTTP API on the same host, any port', () => {
    expect(serverOrigins('wss://scribe.example.com/ws')).toEqual([
      'wss://scribe.example.com/*',
      'https://scribe.example.com/*',
    ]);
    expect(serverOrigins('ws://localhost:8000/ws')).toEqual([
      'ws://localhost/*',
      'http://localhost/*',
    ]);
  });

  it.each(['https://scribe.example.com/ws', 'scribe.example.com', ''])(
    'rejects %j',
    (url) => {
      expect(() => serverOrigins(url)).toThrow();
    },
  );
});

describe('saveServerUrl', () => {
  it('asks for the host, then saves', async () => {
    expect(await saveServerUrl('wss://asr.example.org:9000/ws')).toBeNull();
    expect(chromeStub.permissions.request).toHaveBeenCalledWith({
      origins: ['wss://asr.example.org/*', 'https://asr.example.org/*'],
    });
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe('wss://asr.example.org:9000/ws');
  });

  it('keeps the old server when access is refused', async () => {
    chromeStub.permissions.request.mockResolvedValue(false);
    expect(await saveServerUrl('wss://asr.example.org/ws')).toBe(
      'Access to asr.example.org was not granted.',
    );
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe(DEFAULT_SETTINGS.wsUrl);
  });

  it('does not ask for anything on a bad URL', async () => {
    expect(await saveServerUrl('http://asr.example.org/ws')).toMatch(
      /ws:\/\/ or wss:\/\//,
    );
    expect(chromeStub.permissions.request).not.toHaveBeenCalled();
  });
});

describe('getSettings', () => {
  it('fills in defaults around what was stored', async () => {
    chromeStub.sync.set('withMic', true);
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, withMic: true });
  });
});
