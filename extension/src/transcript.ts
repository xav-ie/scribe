// Speaker attribution by joining ASR word timestamps against the meeting's
// active-speaker timeline — NO audio diarization. The scribe streaming service
// returns words with timestamps relative to the audio stream start; the content
// script (speaker/) scrapes the meeting UI's active-speaker indicator into a
// wall-clock timeline. We convert each word's stream-relative time to wall-clock
// (via the capture-start epoch) and label it with whoever was the active speaker
// at that moment. This is why >4 speakers and real names "just work": we're
// reusing the platform's own per-participant VAD instead of reconstructing it.

/** One decoded word; `start`/`end` are seconds from the audio stream start. */
export interface Word {
  word: string;
  start: number;
  end: number;
}

/** "This participant became the active speaker at wall-clock `from` (epoch ms)." */
export interface SpeakerSpan {
  name: string;
  from: number;
}

/** Contiguous run of words attributed to one speaker; times are stream-seconds. */
export interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

const UNKNOWN_SPEAKER = 'Unknown';

// The active-speaker UI lags real speech by a debounce (~0.4-0.7s) — the
// indicator lights up slightly AFTER someone starts talking. So to find the
// speaker for a word spoken at wall-clock T, we look at the timeline a bit
// later, where the UI had caught up. Tune against real meetings.
const DEFAULT_SPEAKER_LEAD_MS = 500;

/** The active speaker at a given wall-clock epoch. Timeline must be sorted by `from`. */
function speakerAt(timeline: readonly SpeakerSpan[], epoch: number): string {
  let name = UNKNOWN_SPEAKER;
  for (const span of timeline) {
    if (span.from <= epoch) name = span.name;
    else break;
  }
  return name;
}

/**
 * Attribute each word to a speaker and merge consecutive same-speaker words into
 * segments. `captureStartEpoch` is the wall-clock (epoch ms) of audio-stream
 * sample 0, so `captureStartEpoch + wordSeconds*1000` is when the word was said.
 */
export function joinTranscript(
  words: readonly Word[],
  captureStartEpoch: number,
  timeline: readonly SpeakerSpan[],
  leadMs: number = DEFAULT_SPEAKER_LEAD_MS,
): Segment[] {
  const segments: Segment[] = [];
  for (const w of words) {
    const midEpoch = captureStartEpoch + ((w.start + w.end) / 2) * 1000;
    const speaker = speakerAt(timeline, midEpoch + leadMs);
    const last = segments.at(-1);
    if (last && last.speaker === speaker) {
      last.text += ` ${w.word}`;
      last.end = w.end;
    } else {
      segments.push({ speaker, start: w.start, end: w.end, text: w.word });
    }
  }
  return segments;
}
