/**
 * Pure mappings from today's real sources onto the attention store (#55).
 * No connections, timers or second stores are created here; the data-delivery owner
 * (@rohanchakra16) decides where these are called. Structural types are used so this
 * folder does not depend on the evaluation package.
 */
import type { AttentionMarker, AttentionObservation } from './types';

/** The parts of the evaluation player's EvaluationSnapshot this needs (evaluation/player/client.ts). */
export interface EvaluationLike {
  sessionId: string;
  videoId: string;
  status: { score: number | null; state: string };
  config: { lowAttentionMax: number };
  fusion: { calibrated: boolean; combinedLoss: number | null; threshold: number; reason: string } | null;
}

/** Playback state at the moment the snapshot was received (PlaybackStatus satisfies this). */
export interface TickPlayback {
  mediaTimeS: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  replay: unknown | null;
}

/**
 * EvaluationSnapshot -> observation. Combined mode uses `fusion.combinedLoss` (0..1, higher = loss,
 * threshold `fusion.threshold`); EEG-only uses `status.score` (0..100, low <= lowAttentionMax).
 * Returns null while paused, seeking, ended or replaying, because those ticks are not ordinary viewing
 * (the backend also blocks inference during replay). The evaluation API does not echo the tick's
 * media time, so `mediaS` is the player position on receipt (<= ~1 s tick latency; documented).
 */
export function observationFromEvaluation(snapshot: EvaluationLike, playback: TickPlayback, segmentId: string | null = null): AttentionObservation | null {
  if (playback.paused || playback.seeking || playback.ended || playback.replay !== null) return null;
  const base = {
    sessionId: snapshot.sessionId,
    videoId: snapshot.videoId,
    segmentId,
    evidence: null,
    mediaS: playback.mediaTimeS,
    origin: 'measured' as const,
  };
  if (snapshot.fusion) {
    const value = snapshot.fusion.combinedLoss;
    return {
      ...base,
      metric: 'combined_loss',
      value,
      scale: 'loss_0_1',
      valid: snapshot.fusion.calibrated && value !== null && Number.isFinite(value),
      provenance: 'evaluation-player fusion (EEG scripted/offline + webcam gaze)',
      threshold: snapshot.fusion.threshold,
      thresholdVersion: 'evaluation-fusion',
    };
  }
  const value = snapshot.status.score;
  return {
    ...base,
    metric: 'eeg_score',
    value,
    scale: 'score_0_100',
    valid: value !== null && Number.isFinite(value) && snapshot.status.state !== 'unknown',
    provenance: 'evaluation-player EEG (scripted/offline)',
    threshold: snapshot.config.lowAttentionMax,
    thresholdVersion: 'evaluation-eeg',
  };
}

/** The parts of a ReviewBookmark (or a focus moment) a marker needs. */
export interface BookmarkLike {
  bookmarkId: string;
  source: 'experimental_eeg' | 'experimental_gaze' | 'experimental_combined' | 'manual';
  suggestedMediaS: number;
  endMediaS?: number;
  runKind?: 'live' | 'replay' | 'simulated';
  evidenceMedia?: { startMediaS: number; endMediaS: number } | null;
  contributingSignals?: { signal: string; scores: { name: string; scale: string; value: number | null }[] }[];
}

const LABELS: Record<BookmarkLike['source'], string> = {
  manual: 'Your bookmark',
  experimental_eeg: 'EEG review point',
  experimental_gaze: 'Gaze review point',
  experimental_combined: 'EEG + gaze review point',
};

const REASONS: Record<Exclude<BookmarkLike['source'], 'manual'>, string> = {
  experimental_eeg: 'Sustained drop in the experimental EEG estimate.',
  experimental_gaze: 'Sustained look-away from the video in calibrated webcam gaze.',
  experimental_combined: 'Sustained drop in the combined EEG + calibrated gaze estimate.',
};

/** Bookmark -> marker. Manual = bookmark; automatic sources = review point. */
export function markerFromBookmark(b: BookmarkLike): AttentionMarker {
  const simulated = b.runKind === 'simulated';
  const score = b.contributingSignals?.flatMap((s) => s.scores).find((s) => s.scale === 'score_0_100' && s.value !== null)?.value ?? null;
  return {
    id: b.bookmarkId,
    kind: b.source === 'manual' ? 'bookmark' : 'review',
    startS: b.suggestedMediaS,
    endS: b.endMediaS ?? b.evidenceMedia?.endMediaS ?? null,
    origin: simulated ? 'simulated' : 'measured',
    label: simulated ? `${LABELS[b.source]} (simulated)` : LABELS[b.source],
    reason: b.source === 'manual' ? 'Added with “Mark moment”.' : `${REASONS[b.source]}${simulated ? ' Simulated session data, not a real measurement.' : ' Experimental, not a validated attention measurement.'}`,
    score,
  };
}
