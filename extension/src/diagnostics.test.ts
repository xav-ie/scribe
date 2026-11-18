import { describe, expect, it } from 'vitest';
import { HEARTBEAT_MS, keepSnapshot, type Snapshot } from './diagnostics';
import { endNoticesIn } from './speaker/dom';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  platform: 'zoom',
  at: 0,
  frame: 'top',
  tiles: 6,
  names: ['Ana', 'Bo'],
  speaking: 'Ana',
  muted: true,
  ended: [],
  ...over,
});

describe('keepSnapshot', () => {
  it('keeps the first snapshot of each frame', () => {
    expect(keepSnapshot([], snap())).toBe(true);
    expect(keepSnapshot([snap()], snap({ frame: 'https://x/wc/1' }))).toBe(
      true,
    );
  });

  it('drops an unchanged snapshot until the heartbeat', () => {
    const kept = [snap()];
    expect(keepSnapshot(kept, snap({ at: 10_000 }))).toBe(false);
    expect(keepSnapshot(kept, snap({ at: HEARTBEAT_MS }))).toBe(true);
  });

  it('ignores speaking rates', () => {
    expect(
      keepSnapshot([snap({ rates: { Ana: 3 } })], snap({ rates: { Ana: 9 } })),
    ).toBe(false);
  });

  it('keeps a change, compared within the same frame', () => {
    const kept = [snap(), snap({ frame: 'https://x/wc/1', tiles: 0 })];
    expect(keepSnapshot(kept, snap({ speaking: 'Bo' }))).toBe(true);
    expect(keepSnapshot(kept, snap({ ended: ['Meeting ended'] }))).toBe(true);
    expect(keepSnapshot(kept, snap({ at: 10_000 }))).toBe(false);
  });

  it('always keeps a page map', () => {
    const probe = { url: '', frames: [] } as unknown as Snapshot['probe'];
    expect(keepSnapshot([snap()], snap({ probe }))).toBe(true);
  });
});

describe('endNoticesIn', () => {
  it('finds the lines saying the call is over', () => {
    expect(
      endNoticesIn(
        'Chat\nThis meeting has been ended by host\n  You left the meeting  \nRejoin\nReturn to home screen\nMute',
      ),
    ).toEqual([
      'This meeting has been ended by host',
      'You left the meeting',
      'Rejoin',
      'Return to home screen',
    ]);
  });

  it('skips long lines, which are likely chat', () => {
    expect(endNoticesIn(`${'x'.repeat(120)} you left the meeting`)).toEqual([]);
  });

  it('is empty during a call', () => {
    expect(endNoticesIn('Ana\nBo\nMute my microphone\nLeave')).toEqual([]);
  });
});
