/**
 * Choose the transcript excerpt a bookmark's question is generated from.
 * Owner: Person 4 (@aryanmorarji). Issue #72. See src/questions/README.md.
 *
 * Uses the bookmark's evidence interval (the lecture content it covers), not the time the
 * bookmark arrived, because detection can lag the content. Whole sentences only, a little
 * context before the interval, and complete sentences at its boundary. A sentence that starts
 * inside the interval may finish after it; text is never cut just to fit a character budget.
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
  /** Soft target: a final whole sentence may extend this to hardMaxChars. */
  maxChars: number;
  hardMaxChars: number;
}

export const DEFAULT_EXCERPT_OPTIONS: ExcerptOptions = { leadS: 20, manualSpanS: 20, maxChars: 3000, hardMaxChars: 3500 };

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
  // Complete sentences only, including one that straddles the evidence end. This is
  // intentional boundary completion, not a strict no-future-content guarantee.
  const candidates = sentences.filter((s) => s.endS > from && s.startS < endS && s.text.trim());
  const hard = Math.max(0, Math.min(opts.hardMaxChars, 3500));
  const soft = Math.max(0, Math.min(opts.maxChars, hard));
  // Prioritise the end of the flagged interval. Grow backwards to the soft target;
  // allow the last added sentence to cross it, but never the hard limit.
  const picked: Sentence[] = [];
  let length = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const sentence = candidates[i]!;
    const next = length + sentence.text.trim().length + (picked.length ? 1 : 0);
    if (next > hard) break; // never truncate a sentence or hop across missing content
    picked.unshift(sentence);
    length = next;
    if (length >= soft) break;
  }
  if (picked.length === 0) return null;
  const text = picked.map((s) => s.text.trim()).join(' ');
  return { startMediaS: picked[0]!.startS, endMediaS: picked[picked.length - 1]!.endS, text };
}
