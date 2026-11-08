/**
 * React glue: generate a question for each bookmark as it appears. Owner: Person 4 (@aryanmorarji).
 *
 * const questions = useBookmarkQuestions({ bookmarks: activeBookmarks, sentences: transcript?.sentences ?? null,
 *   videoId: lecture?.videoId ?? null, enabled: client.kind === 'live' });
 * questions.get(bookmark.bookmarkId)  // QuestionEntry | undefined
 * questions.request(bookmark)  // explicit per-passage request (default; set auto: true to generate eagerly)
 * questions.retry(bookmark)
 *
 * `enabled` must be false for the synthetic adapter and whenever the viewer has not agreed to
 * send transcript excerpts to OpenRouter.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DEFAULT_BACKEND_URL } from '../integration';
import { getLaunchToken } from '../integration/live/pairing';
import type { Sentence } from '../transcript';
import { requestQuestion } from './client';
import type { BookmarkRange } from './excerpt';
import { createQuestionStore, type QuestionStore } from './store';

export interface UseBookmarkQuestionsArgs {
  bookmarks: readonly BookmarkRange[];
  sentences: readonly Sentence[] | null;
  videoId: string | null;
  enabled: boolean;
  /** Generate for every bookmark as it appears. Default false: only `request(bookmark)` sends text. */
  auto?: boolean;
  backendUrl?: string;
}

export function useBookmarkQuestions({ bookmarks, sentences, videoId, enabled, auto = false, backendUrl }: UseBookmarkQuestionsArgs) {
  const backend = backendUrl ?? (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? DEFAULT_BACKEND_URL;
  const [store] = useState<QuestionStore>(() =>
    createQuestionStore((bookmark, excerpt, signal) =>
      requestQuestion(bookmark, excerpt, { backendUrl: backend, launchToken: getLaunchToken(), signal })));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => { store.reset(videoId); }, [store, videoId]);
  useEffect(() => () => store.dispose(), [store]);

  useEffect(() => {
    if (!enabled || !auto) return;
    for (const bookmark of bookmarks) {
      // A transcript opened after the bookmark arrived: try again now that there is text.
      if (sentences?.length && store.getSnapshot().get(bookmark.bookmarkId)?.status === 'no_transcript') {
        store.retry(bookmark, sentences);
      } else {
        store.ensure(bookmark, sentences);
      }
    }
  }, [store, bookmarks, sentences, enabled, auto]);

  // Explicit, per-passage request (the student pressed "Test your recall"). No-op when disabled.
  const request = useCallback((bookmark: BookmarkRange) => {
    if (!enabled) return;
    if (store.getSnapshot().has(bookmark.bookmarkId)) store.retry(bookmark, sentences);
    else store.ensure(bookmark, sentences);
  }, [store, sentences, enabled]);
  const retry = useCallback((bookmark: BookmarkRange) => { if (enabled) store.retry(bookmark, sentences); }, [store, sentences, enabled]);
  return useMemo(() => ({ get: (id: string) => snapshot.get(id), entries: snapshot, request, retry }), [snapshot, request, retry]);
}
