/**
 * Choose the transcript excerpt a bookmark's question is generated from.
 * Owner: Person 4 (@aryanmorarji). Issue #72. See src/questions/README.md.
 *
 * Uses the bookmark's evidence interval (the lecture content it covers), not the time the
 * bookmark arrived, because detection can lag the content. Whole sentences only, a little
 * context before the interval, and nothing after it: the question must not reveal material the
 * student has not reached yet.
 */
import type { TranscriptContext } from '../integration';
import type { Sentence } from '../transcript';

/** The parts of a bookmark the excerpt needs (ReviewBookmark and focus moments both fit). */
export interface BookmarkRange {
  bookmarkId: string;
  videoId: string;
  suggestedMediaS: number;
  evidenceMedia: { startMediaS: number; endMediaS: number } | null;
}

export interface ExcerptOptions {
  /** Seconds of transcript before the interval to include for context. */
  leadS: number;
  /** Interval length assumed for a bookmark without evidence (e.g. manual). */
  manualSpanS: number;
  /** Upper bound on characters sent; the earliest context is dropped first. */
  maxChars: number;
}

export const DEFAULT_EXCERPT_OPTIONS: ExcerptOptions = { leadS: 20, manualSpanS: 20, maxChars: 3000 };

export function bookmarkInterval(bookmark: BookmarkRange, manualSpanS = DEFAULT_EXCERPT_OPTIONS.manualSpanS) {
  if (bookmark.evidenceMedia) return { startS: bookmark.evidenceMedia.startMediaS, endS: bookmark.evidenceMedia.endMediaS };
  // Manual bookmark: the student marked "now", so ask about what came just before it.
  return { startS: Math.max(0, bookmark.suggestedMediaS - manualSpanS), endS: bookmark.suggestedMediaS };
}

/** Transcript excerpt for a bookmark, or null when no sentence overlaps it. */
export function excerptForBookmark(
  sentences: readonly Sentence[],
  bookmark: BookmarkRange,
  options: Partial<ExcerptOptions> = {},
): TranscriptContext | null {
  const opts = { ...DEFAULT_EXCERPT_OPTIONS, ...options };
  const { startS, endS } = bookmarkInterval(bookmark, opts.manualSpanS);
  const from = Math.max(0, startS - opts.leadS);
  // Overlap with [from, endS]; a sentence that starts after the interval is never included.
  let picked = sentences.filter((s) => s.endS > from && s.startS < endS && s.text.trim());
  if (picked.length === 0) return null;
  while (picked.length > 1 && picked.reduce((n, s) => n + s.text.length + 1, 0) > opts.maxChars) picked = picked.slice(1);
  const text = picked.map((s) => s.text.trim()).join(' ').slice(-opts.maxChars);
  return { startMediaS: picked[0]!.startS, endMediaS: picked[picked.length - 1]!.endS, text };
}
