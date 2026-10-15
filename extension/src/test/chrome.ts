// A minimal in-memory `chrome` for unit tests: storage.sync, permissions and
// the manifest, which is all the tested modules touch. Tests reset it and
// steer `permissions.request` through `chromeStub`.

import { beforeEach, vi } from 'vitest';

const sync = new Map<string, unknown>();

export const chromeStub = {
  sync,
  permissions: { request: vi.fn(async () => true) },
};

const fake = {
  runtime: {
    getManifest: () => ({ version: '0.0.0', version_name: '0.0.0 test' }),
  },
  permissions: chromeStub.permissions,
  storage: {
    sync: {
      async get(defaults: Record<string, unknown>) {
        const out: Record<string, unknown> = { ...defaults };
        for (const [k, v] of sync) out[k] = v;
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) sync.set(k, v);
      },
    },
  },
};

(globalThis as unknown as { chrome: typeof fake }).chrome = fake;

beforeEach(() => {
  sync.clear();
  chromeStub.permissions.request.mockReset();
  chromeStub.permissions.request.mockResolvedValue(true);
});
