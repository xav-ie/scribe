import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiHeaders,
  apiUrl,
  checkServer,
  DEFAULT_SETTINGS,
  getSettings,
  grantServerAccess,
  saveServerUrl,
  serverOrigins,
  splitServerUrl,
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

// A fake scribe server for fetch: whether it has a token, and which one.
function fakeServer(token: string | null, { down = false } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url.pathname === '/api/info') {
        return Response.json({ auth: token !== null });
      }
      const sent = new Headers(init?.headers).get('Authorization');
      const ok = token === null || sent === `Bearer ${token}`;
      return new Response('{}', { status: ok ? 200 : 401 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkServer', () => {
  it.each([
    [null, 'wss://s.example.com/ws', 'open'],
    ['abc', 'wss://s.example.com/ws', 'needs-token'],
    ['abc', 'wss://s.example.com/ws#token=nope', 'bad-token'],
    ['abc', 'wss://s.example.com/ws#token=abc', 'ok'],
  ] as const)('server token %s, URL %s: %s', async (token, url, expected) => {
    fakeServer(token);
    expect(await checkServer(url)).toBe(expected);
  });

  it('reports a server that does not answer', async () => {
    fakeServer(null, { down: true });
    expect(await checkServer('wss://s.example.com/ws')).toBe('unreachable');
  });
});

describe('saveServerUrl', () => {
  it('saves when the host is allowed and the server accepts the URL', async () => {
    chromeStub.permissions.contains.mockResolvedValue(true);
    fakeServer('abc');
    expect(
      await saveServerUrl('wss://asr.example.org:9000/ws#token=abc'),
    ).toEqual({
      status: 'saved',
      server: 'ok',
    });
    expect(chromeStub.permissions.request).not.toHaveBeenCalled();
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe('wss://asr.example.org:9000/ws#token=abc');
  });

  it.each(['wss://asr.example.org/ws', 'wss://asr.example.org/ws#token=nope'])(
    'refuses %s when the server wants another token',
    async (url) => {
      chromeStub.permissions.contains.mockResolvedValue(true);
      fakeServer('abc');
      const result = await saveServerUrl(url);
      expect(result).toMatchObject({ status: 'invalid' });
      const { wsUrl } = await getSettings();
      expect(wsUrl).toBe(DEFAULT_SETTINGS.wsUrl);
    },
  );

  it('saves an open or silent server, saying which', async () => {
    chromeStub.permissions.contains.mockResolvedValue(true);
    fakeServer(null);
    expect(await saveServerUrl('wss://asr.example.org/ws')).toEqual({
      status: 'saved',
      server: 'open',
    });
    fakeServer(null, { down: true });
    expect(await saveServerUrl('wss://asr.example.org/ws')).toEqual({
      status: 'saved',
      server: 'unreachable',
    });
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
    // eslint-disable-next-line unicorn/prefer-https -- http:// is the input being rejected
    const result = await saveServerUrl('http://asr.example.org/ws');
    expect(result).toMatchObject({ status: 'invalid' });
    expect(chromeStub.permissions.contains).not.toHaveBeenCalled();
  });
});

describe('grantServerAccess', () => {
  const url = 'wss://asr.example.org/ws';
  const origins = serverOrigins(url);

  it('checks and saves once Chrome grants access', async () => {
    fakeServer(null);
    expect(await grantServerAccess(url, origins)).toEqual({
      status: 'saved',
      server: 'open',
    });
    expect(chromeStub.permissions.request).toHaveBeenCalledWith({ origins });
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe(url);
  });

  it('keeps the old server when access is refused', async () => {
    chromeStub.permissions.request.mockResolvedValue(false);
    expect(await grantServerAccess(url, origins)).toEqual({
      status: 'invalid',
      error: 'Access to asr.example.org was not granted.',
    });
    const { wsUrl } = await getSettings();
    expect(wsUrl).toBe(DEFAULT_SETTINGS.wsUrl);
  });
});

describe('getSettings', () => {
  it('fills in defaults around what was stored', async () => {
    chromeStub.sync.set('debug', true);
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, debug: true });
  });
});

describe('splitServerUrl', () => {
  it('takes the token out of the fragment', () => {
    expect(splitServerUrl('wss://s.example.com/ws#token=abc123')).toEqual({
      url: 'wss://s.example.com/ws',
      token: 'abc123',
    });
  });

  it('leaves a plain URL alone', () => {
    expect(splitServerUrl('ws://localhost:8000/ws')).toEqual({
      url: 'ws://localhost:8000/ws',
      token: undefined,
    });
  });
});

describe('apiUrl and apiHeaders', () => {
  it('point at the HTTP API on the same host, with the token', () => {
    const saved = 'wss://s.example.com/ws#token=abc123';
    expect(apiUrl(saved, '/api/info').href).toBe(
      'https://s.example.com/api/info',
    );
    expect(apiUrl('ws://localhost:8000/ws', '/api/info').href).toBe(
      'http://localhost:8000/api/info',
    );
    expect(apiHeaders(saved)).toEqual({ Authorization: 'Bearer abc123' });
    expect(apiHeaders('ws://localhost:8000/ws')).toEqual({});
  });
});
