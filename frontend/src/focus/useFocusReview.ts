import { useEffect, useState } from 'react';
import type { LoadedLecture, PlayerHandle } from '../player';
import { observeEvaluation, type EvaluationSnapshot, type Segment } from '../../../evaluation/player/client';
import { GazeWindowBuffer } from '../../../evaluation/player/gaze';
import type { ReviewClient } from '../integration';
import { GazeLiveStore } from './gazeLive';

/** Product composition over the already tested evaluator; no second detector. */
export function useFocusReview(player: PlayerHandle | null, lecture: LoadedLecture | null, duration: number | null, client?: ReviewClient) {
  const [gaze] = useState(() => new GazeWindowBuffer());
  const [gazeLive] = useState(() => new GazeLiveStore());
  const [enabled, setEnabled] = useState(false);
  const [snapshot, setSnapshot] = useState<EvaluationSnapshot | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Segment | null>(null);
  useEffect(() => {
    setSnapshot(null); setError(''); setNotice(null);
    if (client?.kind === 'live' || !enabled || !player || !lecture || !duration) return;
    const seen = new Set<string>();
    return observeEvaluation(player, lecture.videoId, duration, (next) => {
      setSnapshot(next);
      for (const segment of next.bookmarks) {
        if (!seen.has(segment.segmentId)) { seen.add(segment.segmentId); setNotice(segment); }
      }
    }, (message) => { setError(message); setNotice(null); }, { combineGaze: true, readGaze: () => gaze.read() });
  }, [enabled, player, lecture, duration, gaze, attempt, client]);
  const current = snapshot?.videoId === lecture?.videoId ? snapshot : null;
  return {
    gaze, gazeLive, enabled, client, live: client?.kind === 'live', snapshot: current, error, notice,
    start: () => setEnabled(true),
    closeNotice: () => setNotice(null),
    reconnect: () => setAttempt((n) => n + 1),
    moments: (current?.bookmarks ?? []).map((segment) => ({
      bookmarkId: `focus:${current!.sessionId}:${segment.segmentId}`,
      videoId: current!.videoId,
      suggestedMediaS: segment.mediaRange.startMediaS,
      endMediaS: segment.mediaRange.endMediaS,
      source: 'experimental_combined' as const,
    })),
  };
}
