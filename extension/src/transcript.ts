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
// certainty, even when the active-speaker UI shows someone else. While you're
// muted the offscreen sends it silence, so it adds no words.

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

/**
 * Apply one streamed update: the stream's words from index `from` on are
 * replaced by `words` (only the last word sent before can still change). An
 * update starting past the words held means some went missing; it is refused
 * (false) so the caller can ask for the full list instead.
 */
export function applyWords(
  target: Word[],
  from: number,
  words: readonly Word[],
): boolean {
  if (!Number.isSafeInteger(from) || from < 0 || from > target.length)
    return false;
  target.splice(from, Infinity, ...words);
  return true;
}

// The active-speaker UI lights up a little AFTER someone starts talking, so to
// find the speaker for a word spoken at wall-clock T, we look at the timeline a
// bit later, where the UI had caught up. 900 ms best matched TitaNet voiceprints
// of words near speaker changes in a 3-person Zoom call (91% vs 86% at 500 ms);
// the voiceprints agreed with Zoom on every confident mid-turn word.
const DEFAULT_SPEAKER_LEAD_MS = 900;

/** The active speaker at a given wall-clock epoch. Timeline must be sorted by `from`. */
function speakerAt(timeline: readonly SpeakerSpan[], epoch: number): string {
  let name = UNKNOWN_SPEAKER;
  for (const span of timeline) {
    if (span.from <= epoch) name = span.name;
    else break;
  }
  return name;
}

// A stream's words at their wall-clock time (its clock plus the word's middle),
// each labelled by `speaker`. None until the stream's clock is known.
function stamp(
  stream: Channel,
  speaker: (at: number) => string,
): { at: number; speaker: string; word: string }[] {
  const { epoch } = stream;
  if (epoch === null) return [];
  return stream.words.map((w) => {
    const at = epoch + ((w.start + w.end) / 2) * 1000;
    return { at, speaker: speaker(at), word: w.word };
  });
}

/**
 * Merge the tab streams (attributed via the active-speaker timeline; one per
 * capture, so a resumed recording has several) and the mic streams (always the
 * local user) into one time-ordered, speaker-grouped script.
 * Each word is stamped with its wall-clock time (`epoch + wordSeconds*1000`) so
 * the two independently-timed streams interleave correctly; `start`/`end` on the
 * returned segments are seconds from the first word.
 */
export function mergeTranscript(
  tab: readonly Channel[],
  mic: readonly Channel[],
  timeline: readonly SpeakerSpan[],
  micName: string,
  leadMs: number = DEFAULT_SPEAKER_LEAD_MS,
): Segment[] {
  const stamped = [
    ...tab.flatMap((stream) =>
      stamp(stream, (at) => speakerAt(timeline, at + leadMs)),
    ),
    ...mic.flatMap((stream) => stamp(stream, () => micName)),
  ];
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
