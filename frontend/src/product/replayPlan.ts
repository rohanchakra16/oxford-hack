import { replayStartFor, sentenceIndexAt, type Sentence } from '../transcript';

/** Shortest replay worth bounding; below this (or an unusable range) playback continues from the start instead. */
export const MIN_REPLAY_S = 3;
/** A range shorter than this cannot be replayed (the controller needs end > start). */
const MIN_RANGE_S = 0.5;

export interface ReplayPlan {
  startS: number;
  /** Bounded replay end, or null to seek to `startS` and keep playing. */
  endS: number | null;
}

interface ReplaySubject {
  suggestedMediaS: number;
  /** Known end of the moment (a focus segment that has finished), media seconds. */
  endMediaS?: number;
}

/**
 * Where a bookmark replay starts and stops. With a transcript the start is the containing sentence
 * (`earlier` whole sentences back) and the end is that sentence's end, at least `MIN_REPLAY_S` later.
 * Without one a finished focus segment bounds the replay. Anything that does not fit inside the media
 * (zero length, unfinished, past the end, start after end) falls back to seek-and-play instead of
 * producing a range the player would reject.
 */
export function planReplay(
  sentences: readonly Sentence[],
  subject: ReplaySubject,
  earlier: number,
  durationS: number | null,
): ReplayPlan {
  const containing = sentenceIndexAt(sentences, subject.suggestedMediaS);
  const rawStart =
    containing >= 0 ? replayStartFor(sentences, subject.suggestedMediaS, earlier) : subject.suggestedMediaS;
  const limit = durationS !== null && Number.isFinite(durationS) ? durationS : Infinity;
  const startS = Math.min(Math.max(0, Number.isFinite(rawStart) ? rawStart : 0), limit);
  let rawEnd: number | null = null;
  if (containing >= 0) rawEnd = Math.max(sentences[containing]!.endS, startS + MIN_REPLAY_S);
  else if (subject.endMediaS !== undefined) rawEnd = subject.endMediaS;
  if (rawEnd === null || !Number.isFinite(rawEnd)) return { startS, endS: null };
  const endS = Math.min(rawEnd, limit);
  return endS - startS >= MIN_RANGE_S ? { startS, endS } : { startS, endS: null };
}
