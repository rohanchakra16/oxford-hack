import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AttentionTimelineStore, freezeSnapshot } from './store';
import type { TimelineSnapshot } from './types';

/** Live store snapshot (re-renders on every change). */
export function useTimeline(store: AttentionTimelineStore): TimelineSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export interface RefreshedTimeline {
  /** Attention lines as of the last refresh; markers, availability and completion are always current. */
  snapshot: TimelineSnapshot;
  /** performance.now() of the last line refresh, or null before data. */
  refreshedAt: number | null;
  refreshNow(): void;
}

/**
 * Periodic refresh for the live graph. Attention lines are published every `refreshMs`
 * (2 minutes by default); the first data, a lecture change and completion publish immediately.
 * Markers (review points / bookmarks) are never delayed, so they are clickable as soon as they exist.
 * refreshMs <= 0 means always live (used by the end-of-lecture summary).
 */
export function useRefreshedTimeline(store: AttentionTimelineStore, refreshMs = 120_000): RefreshedTimeline {
  const live = useTimeline(store);
  const [published, setPublished] = useState<{ snap: TimelineSnapshot; at: number | null }>(() => ({ snap: freezeSnapshot(live), at: hasPoints(live) ? performance.now() : null }));
  const liveRef = useRef(live);
  liveRef.current = live;

  const publish = () => setPublished({ snap: freezeSnapshot(liveRef.current), at: performance.now() });

  // Immediate publish: lecture changed, first data arrived, or the lecture completed.
  const needsImmediate =
    published.snap.videoId !== live.videoId ||
    (!hasPoints(published.snap) && hasPoints(live)) ||
    (live.completed && !published.snap.completed) ||
    published.snap.segments.length > live.segments.length; // cleared
  useEffect(() => {
    if (needsImmediate) publish();
  });

  useEffect(() => {
    if (refreshMs <= 0) return;
    const id = setInterval(publish, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, store]);

  if (refreshMs <= 0) return { snapshot: live, refreshedAt: null, refreshNow: () => {} };
  const snapshot: TimelineSnapshot = { ...live, segments: published.snap.segments, threshold: published.snap.threshold ?? live.threshold };
  return { snapshot, refreshedAt: published.at, refreshNow: publish };
}

/** The parts of PlayerHandle lecture tracking needs. */
export interface LecturePlayback {
  subscribe(listener: () => void): () => void;
  getState(): { durationS: number | null; ended: boolean };
  getLecture(): { videoId: string } | null;
}

/**
 * Keeps the store on the player's current lecture: open on load (restores saved history),
 * duration from metadata, completed on `ended`, flush on pagehide. Creates no connection.
 */
export function useAttentionLecture(store: AttentionTimelineStore, player: LecturePlayback | null): void {
  useEffect(() => {
    if (!player) return;
    const sync = () => {
      const lecture = player.getLecture();
      const state = player.getState();
      if (!lecture) return;
      store.open(lecture.videoId, state.durationS);
      if (state.ended) store.markCompleted();
    };
    sync();
    const off = player.subscribe(sync);
    const flush = () => store.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      off();
      window.removeEventListener('pagehide', flush);
      store.flush();
    };
  }, [store, player]);
}

function hasPoints(s: TimelineSnapshot) {
  return s.segments.some((seg) => seg.points.length > 0);
}
