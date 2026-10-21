import { describe, expect, it } from 'vitest';
import {
  applyWords,
  mergeTranscript,
  type SpeakerSpan,
  type Word,
} from './transcript';

const w = (word: string, start: number, end = start + 0.2): Word => ({
  word,
  start,
  end,
});
const words = (list: Word[]) => list.map((x) => x.word);

describe('applyWords', () => {
  it('replays the server protocol into the full word list', () => {
    // The updates /ws sends for "hel" → "hello wor" → "hello world again".
    const updates: [number, Word[]][] = [
      [0, [w('hel', 0)]],
      [0, [w('hello', 0), w('wor', 1)]],
      [1, [w('world', 1), w('again', 2)]],
    ];
    const target: Word[] = [];
    for (const [from, ws] of updates) {
      expect(applyWords(target, from, ws)).toBe(true);
    }
    expect(words(target)).toEqual(['hello', 'world', 'again']);
  });

  it('accepts a full resend from 0', () => {
    const target = [w('a', 0), w('b', 1)];
    expect(applyWords(target, 0, [w('a', 0), w('bc', 1), w('d', 2)])).toBe(
      true,
    );
    expect(words(target)).toEqual(['a', 'bc', 'd']);
  });

  it('appends at the end', () => {
    const target = [w('a', 0)];
    expect(applyWords(target, 1, [w('b', 1)])).toBe(true);
    expect(words(target)).toEqual(['a', 'b']);
  });

  it.each([2, -1, 0.5, NaN])(
    'refuses an update from %s, leaving the words alone',
    (from) => {
      const target = [w('a', 0)];
      expect(applyWords(target, from, [w('x', 5)])).toBe(false);
      expect(words(target)).toEqual(['a']);
    },
  );
});

describe('mergeTranscript', () => {
  const EPOCH = 1_000_000;
  const timeline: SpeakerSpan[] = [
    { name: 'Ada', from: EPOCH },
    { name: 'Grace', from: EPOCH + 5000 },
  ];

  it('labels tab words with whoever the meeting showed, a lead later', () => {
    const tab = {
      epoch: EPOCH,
      words: [w('hi', 1), w('there', 2), w('hello', 4.5), w('back', 6)],
    };
    const segments = mergeTranscript([tab], [], timeline, 'Me', 900);
    expect(segments.map((s) => [s.speaker, s.text])).toEqual([
      ['Ada', 'hi there'],
      // 4.6 s + 0.9 s lead lands in Grace's span: the UI lags the voice.
      ['Grace', 'hello back'],
    ]);
  });

  it('calls speech before the first speaker event Unknown', () => {
    const tab = { epoch: EPOCH - 10_000, words: [w('early', 0)] };
    const [segment] = mergeTranscript([tab], [], timeline, 'Me');
    expect(segment.speaker).toBe('Unknown');
  });

  it('interleaves mic words, always the local user, by wall clock', () => {
    const tab = { epoch: EPOCH, words: [w('one', 1), w('three', 3)] };
    const mic = [
      { epoch: EPOCH + 1000, words: [w('two', 1)] },
      { epoch: EPOCH + 3000, words: [w('four', 1)] },
    ];
    const segments = mergeTranscript([tab], mic, timeline, 'Me');
    expect(segments.map((s) => `${s.speaker}: ${s.text}`)).toEqual([
      'Ada: one',
      'Me: two',
      'Ada: three',
      'Me: four',
    ]);
  });

  it('joins the tab streams of a resumed recording on one clock', () => {
    const tab = [
      { epoch: EPOCH, words: [w('before', 1)] },
      { epoch: EPOCH + 4000, words: [w('after', 2)] },
    ];
    const segments = mergeTranscript(tab, [], timeline, 'Me');
    expect(segments.map((s) => [s.speaker, s.text, s.start])).toEqual([
      ['Ada', 'before', 0],
      ['Grace', 'after', 5],
    ]);
  });

  it('times segments from the first word and keeps its wall clock', () => {
    const tab = { epoch: EPOCH, words: [w('a', 1, 1.2), w('b', 2, 2.2)] };
    const [segment] = mergeTranscript([tab], [], timeline, 'Me');
    expect(segment).toEqual({
      speaker: 'Ada',
      start: 0,
      end: 1,
      text: 'a b',
      at: EPOCH + 1100,
    });
  });

  it('skips streams whose clock is not known yet', () => {
    const segments = mergeTranscript(
      [{ epoch: null, words: [w('lost', 0)] }],
      [{ epoch: null, words: [w('lost', 0)] }],
      timeline,
      'Me',
    );
    expect(segments).toEqual([]);
  });
});
