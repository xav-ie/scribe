import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getSettings,
  grantServerAccess,
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
  it('saves straight away when the host is already allowed', async () => {
    chromeStub.permissions.contains.mockResolvedValue(true);
    expect(await saveServerUrl('wss://asr.example.org:9000/ws')).toEqual({
      status: 'saved',
    });
    expect(chromeStub.permissions.request).not.toHaveBeenCalled();
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe('wss://asr.example.org:9000/ws');
  });

  it('asks the page to get access first, without prompting itself', async () => {
    expect(await saveServerUrl('wss://asr.example.org:9000/ws')).toEqual({
      status: 'needs-access',
      host: 'asr.example.org',
      origins: ['wss://asr.example.org/*', 'https://asr.example.org/*'],
    });
    expect(chromeStub.permissions.request).not.toHaveBeenCalled();
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe(DEFAULT_SETTINGS.wsUrl);
  });

  it('rejects a bad URL without checking access', async () => {
    const result = await saveServerUrl('http://asr.example.org/ws');
    expect(result).toMatchObject({ status: 'invalid' });
    expect(chromeStub.permissions.contains).not.toHaveBeenCalled();
  });
});

describe('grantServerAccess', () => {
  const url = 'wss://asr.example.org/ws';
  const origins = serverOrigins(url);

  it('saves once Chrome grants access', async () => {
    expect(await grantServerAccess(url, origins)).toBeNull();
    expect(chromeStub.permissions.request).toHaveBeenCalledWith({ origins });
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe(url);
  });

  it('keeps the old server when access is refused', async () => {
    chromeStub.permissions.request.mockResolvedValue(false);
    expect(await grantServerAccess(url, origins)).toBe(
      'Access to asr.example.org was not granted.',
    );
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe(DEFAULT_SETTINGS.wsUrl);
  });
});

describe('getSettings', () => {
  it('fills in defaults around what was stored', async () => {
    chromeStub.sync.set('withMic', true);
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, withMic: true });
  });
});
