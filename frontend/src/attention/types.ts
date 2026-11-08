/**
 * Attention timeline types (#55). Owner: Person 4 (@aryanmorarji).
 *
 * The store input is a plain interface, deliberately not a wire event: no new transport event
 * exists until the EEG score contract is agreed (lead decision on the board, #1). Whoever owns
 * data delivery maps their source onto AttentionObservation; see adapters.ts for the mappings
 * that exist today.
 */

/** Where a value came from. Simulated values are Demo mode only and are always labelled. */
export type ObservationOrigin = 'measured' | 'simulated';

/**
 * How `value` is read.
 * - score_0_100: 0..100, higher = more attentive (e.g. live_attention `attention_score`).
 * - loss_0_1:    0..1, higher = more attention loss (e.g. evaluation `fusion.combinedLoss`).
 * Anything else is kept but not plotted (no guessing of unknown scales).
 */
export type ObservationScale = 'score_0_100' | 'loss_0_1' | (string & {});

export interface MediaRange {
  startMediaS: number;
  endMediaS: number;
}

/** One attention measurement, as delivered by the data layer. Times are MEDIA seconds. */
export interface AttentionObservation {
  sessionId: string;
  videoId: string;
  /** Continuous playback segment id; a seek/rewind starts a new one. Separate viewings stay distinct. */
  segmentId: string | null;
  /** Media interval the evidence covers, when the clock mapping is valid. */
  evidence: MediaRange | null;
  /** Mapped media position of the measurement (usually evidence end), when valid. */
  mediaS: number | null;
  /** Metric name, e.g. 'combined_loss', 'attention_score', 'baseline_similarity'. */
  metric: string;
  value: number | null;
  scale: ObservationScale;
  /** False for unknown / unavailable / warm-up windows. Invalid values become gaps, never zero. */
  valid: boolean;
  origin: ObservationOrigin;
  /** Free-text provenance, e.g. 'evaluation-player fusion' or 'demo-mode'. */
  provenance: string;
  /** Low-attention threshold on the same scale as `value`, when known. */
  threshold?: number | null;
  thresholdVersion?: string | null;
}

/** A stored, normalised point. `score` is always 0..100, higher = more attentive. */
export interface AttentionPoint {
  /** Media seconds (centre of the evidence, or mediaS). */
  t: number;
  /** Null = gap (invalid / unavailable). */
  score: number | null;
  low: boolean;
}

/** One continuous run of playback for one session; drawn as its own line. */
export interface AttentionSegment {
  key: string;
  sessionId: string;
  segmentId: string | null;
  origin: ObservationOrigin;
  metric: string;
  /** Strictly increasing t within a segment. */
  points: AttentionPoint[];
  /** Order the segment was created in (for "latest viewing wins"). */
  seq: number;
}

export type MarkerKind = 'review' | 'bookmark';

/** A review point (automatic) or a bookmark (manual), on the media timeline. */
export interface AttentionMarker {
  id: string;
  kind: MarkerKind;
  startS: number;
  endS: number | null;
  origin: ObservationOrigin;
  /** Short label, e.g. 'Combined EEG + gaze', 'Your marker'. */
  label: string;
  /** Why it was generated, when the source says so. */
  reason?: string | null;
  /** 0..100 attention score at the time, when known. */
  score?: number | null;
}

/** Derived, not stored: contiguous low-attention runs from the latest viewing. */
export interface LowRegion {
  id: string;
  startS: number;
  endS: number;
  minScore: number | null;
  origin: ObservationOrigin;
}

export type ScoreAvailability =
  | { state: 'available' }
  /** e.g. live mode with no score stream: real markers only. */
  | { state: 'unavailable'; message: string };

export interface TimelineSnapshot {
  videoId: string | null;
  durationS: number | null;
  /** 0..100 threshold (score <= threshold is low), when known. */
  threshold: number | null;
  thresholdVersion: string | null;
  segments: readonly AttentionSegment[];
  markers: readonly AttentionMarker[];
  completed: boolean;
  availability: ScoreAvailability;
  /** Increments on every change; cheap equality for memoisation. */
  revision: number;
}

export interface TimelineStats {
  measuredSeconds: number;
  unavailablePoints: number;
  average: number | null;
  lowest: { t: number; score: number } | null;
  lowSeconds: number;
  lowRegions: number;
  reviewPoints: number;
  bookmarks: number;
  hasSimulated: boolean;
}

/** The parts of PlayerHandle the graph needs (a PlayerHandle satisfies this). */
export interface PlaybackSource {
  subscribe(listener: () => void): () => void;
  getState(): { mediaTimeS: number; durationS: number | null };
}
