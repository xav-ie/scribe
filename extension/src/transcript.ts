// Speaker attribution by joining ASR word timestamps against the meeting's
// active-speaker timeline — NO audio diarization. The scribe streaming service
// returns words with timestamps relative to the audio stream start; the content
// script (speaker/) scrapes the meeting UI's active-speaker indicator into a
// wall-clock timeline. We convert each word's stream-relative time to wall-clock
// (via the capture-start epoch) and label it with whoever was the active speaker
// at that moment. This is why >4 speakers and real names "just work": we're
// reusing the platform's own per-participant VAD instead of reconstructing it.
//
// The local mic is a SEPARATE stream (not mixed into the tab audio) and is
// always attributed to the local user — it's the one voice we can label with
// certainty, even while muted, where the active-speaker UI would (wrongly) show
// someone else.

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

/** Contiguous run of words attributed to one speaker; times are seconds. */
export interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
  /** Wall-clock epoch (ms) of the first word, for seeking saved audio. */
  at: number;
}

/** One ASR stream's words plus the wall-clock epoch (ms) of its sample 0. */
export interface Channel {
  words: readonly Word[];
  epoch: number | null;
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
 * Merge the tab stream (attributed via the active-speaker timeline) and the mic
 * streams (always the local user) into one time-ordered, speaker-grouped script.
 * Each word is stamped with its wall-clock time (`epoch + wordSeconds*1000`) so
 * the two independently-timed streams interleave correctly; `start`/`end` on the
 * returned segments are seconds from the first word.
 */
export function mergeTranscript(
  tab: Channel,
  mic: readonly Channel[],
  timeline: readonly SpeakerSpan[],
  micName: string,
  leadMs: number = DEFAULT_SPEAKER_LEAD_MS,
): Segment[] {
  const stamped: { at: number; speaker: string; word: string }[] = [];
  if (tab.epoch !== null) {
    for (const w of tab.words) {
      const at = tab.epoch + ((w.start + w.end) / 2) * 1000;
      stamped.push({
        at,
        speaker: speakerAt(timeline, at + leadMs),
        word: w.word,
      });
    }
  }
  for (const stream of mic) {
    if (stream.epoch === null) continue;
    for (const w of stream.words) {
      const at = stream.epoch + ((w.start + w.end) / 2) * 1000;
      stamped.push({ at, speaker: micName, word: w.word });
    }
  }
  stamped.sort((a, b) => a.at - b.at);

  const origin = stamped.length > 0 ? stamped[0].at : 0;
  const segments: Segment[] = [];
  for (const s of stamped) {
    const t = (s.at - origin) / 1000;
    const last = segments.at(-1);
    if (last && last.speaker === s.speaker) {
      last.text += ` ${s.word}`;
      last.end = t;
    } else {
      segments.push({
        speaker: s.speaker,
        start: t,
        end: t,
        text: s.word,
        at: s.at,
      });
    }
  }
  return segments;
}
