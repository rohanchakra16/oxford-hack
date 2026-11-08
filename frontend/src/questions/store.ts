/**
 * Per-bookmark question state. Owner: Person 4 (@aryanmorarji). Issue #72.
 *
 * One entry per bookmark, created the moment the bookmark is seen. Generation runs in the
 * background; bookmarks, playback and replay never wait for it. A bookmark is requested once
 * (repeated snapshots and re-renders are de-duplicated); `retry` is explicit. Changing lecture
 * clears the store and late responses for the old lecture are discarded.
 */
import type { Sentence } from '../transcript';
import type { TranscriptContext } from '../integration';
import type { GeneratedQuestion, QuestionOutcome, ProviderErrorCode } from './client';
import { excerptForBookmark, type BookmarkRange, type ExcerptOptions } from './excerpt';

export type QuestionEntry =
  | { status: 'generating'; excerpt: TranscriptContext }
  | { status: 'ready'; excerpt: TranscriptContext; result: GeneratedQuestion }
  | { status: 'insufficient_context'; excerpt: TranscriptContext | null }
  | { status: 'no_transcript' }
  | { status: 'skipped_non_instructional'; excerpt: TranscriptContext; reason: string }
  | { status: 'unavailable'; excerpt: TranscriptContext; code: ProviderErrorCode; message: string; retryAfterS: number | null };

export type QuestionSnapshot = ReadonlyMap<string, QuestionEntry>;

export type RequestFn = (bookmark: BookmarkRange, excerpt: TranscriptContext, signal: AbortSignal, sentences: readonly Sentence[]) => Promise<QuestionOutcome>;

export interface QuestionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): QuestionSnapshot;
  /** Start generation for a bookmark if it has no entry yet. Returns immediately. */
  ensure(bookmark: BookmarkRange, sentences: readonly Sentence[] | null): void;
  /** Re-request an unavailable or no-transcript entry. */
  retry(bookmark: BookmarkRange, sentences: readonly Sentence[] | null): void;
  /** New lecture or session: clear entries and ignore in-flight responses. */
  reset(videoId: string | null): void;
  dispose(): void;
}

export function createQuestionStore(request: RequestFn, excerptOptions: Partial<ExcerptOptions> = {}): QuestionStore {
  let entries = new Map<string, QuestionEntry>();
  let videoId: string | null = null;
  let generation = 0;
  let aborts = new Set<AbortController>();
  const listeners = new Set<() => void>();

  const set = (id: string, entry: QuestionEntry) => {
    entries = new Map(entries).set(id, entry);
    listeners.forEach((l) => l());
  };

  const start = (bookmark: BookmarkRange, sentences: readonly Sentence[] | null) => {
    if (videoId !== null && bookmark.videoId !== videoId) return;
    if (!sentences || sentences.length === 0) { set(bookmark.bookmarkId, { status: 'no_transcript' }); return; }
    const excerpt = excerptForBookmark(sentences, bookmark, excerptOptions);
    if (!excerpt) { set(bookmark.bookmarkId, { status: 'insufficient_context', excerpt: null }); return; }
    set(bookmark.bookmarkId, { status: 'generating', excerpt });
    const mine = generation;
    const abort = new AbortController();
    aborts.add(abort);
    request(bookmark, excerpt, abort.signal, sentences)
      .then((outcome) => {
        if (mine !== generation) return; // a late answer for the previous lecture
        if (outcome.status === 'ready') set(bookmark.bookmarkId, { status: 'ready', excerpt, result: outcome.result });
        else if (outcome.status === 'insufficient_context') set(bookmark.bookmarkId, { status: 'insufficient_context', excerpt });
        else if (outcome.status === 'skipped_non_instructional') set(bookmark.bookmarkId, { status: 'skipped_non_instructional', excerpt, reason: outcome.reason });
        else set(bookmark.bookmarkId, { status: 'unavailable', excerpt, code: outcome.code, message: outcome.message, retryAfterS: outcome.retryAfterS });
      })
      .catch(() => {
        if (mine === generation && !abort.signal.aborted) {
          set(bookmark.bookmarkId, { status: 'unavailable', excerpt, code: 'network', message: 'Cannot reach the local backend.', retryAfterS: null });
        }
      })
      .finally(() => aborts.delete(abort));
  };

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => entries,
    ensure(bookmark, sentences) { if (!entries.has(bookmark.bookmarkId)) start(bookmark, sentences); },
    retry(bookmark, sentences) {
      const status = entries.get(bookmark.bookmarkId)?.status;
      if (status === undefined || status === 'unavailable' || status === 'no_transcript') start(bookmark, sentences);
    },
    reset(next) {
      generation += 1;
      aborts.forEach((a) => a.abort());
      aborts = new Set();
      videoId = next;
      entries = new Map();
      listeners.forEach((l) => l());
    },
    dispose() { this.reset(null); listeners.clear(); },
  };
}
