/**
 * AttentionTimelineStore: the single attention history for one open lecture (#55).
 * One instance drives both the live sidebar graph and the end-of-lecture summary.
 * Owner: Person 4 (@aryanmorarji). Pure TypeScript; no React, no transport, no player.
 *
 * Guarantees
 * - Media time only. Observations without a valid media mapping are dropped, never placed by wall clock.
 * - Invalid / unavailable values are stored as gaps (score null), never as zero, never interpolated.
 * - Separate viewings stay distinct: every (session, playback segment, metric, origin) is its own line.
 *   Within one segment, one point per media second (a repeat replaces it, out-of-order is ignored).
 * - Markers are deduplicated by id; markers loaded from storage never re-trigger notifications.
 * - Bounded: at most `maxPoints` points in total; the oldest viewings are dropped first.
 * - Persisted per videoId in localStorage (versioned; malformed data is ignored), throttled.
 * - Simulated (Demo mode) data is tagged and kept apart from measured data.
 */
import type {
  AttentionMarker,
  AttentionObservation,
  AttentionPoint,
  AttentionSegment,
  LowRegion,
  ObservationOrigin,
  ScoreAvailability,
  TimelineSnapshot,
  TimelineStats,
} from './types';

export const STORAGE_PREFIX = 'recallroom.attention.v1:';
const FORMAT_VERSION = 1;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoreOptions {
  /** Defaults to window.localStorage when available; null disables persistence. */
  storage?: KeyValueStorage | null;
  maxPoints?: number;
  /** Delay before writing to storage after a change (ms). */
  saveDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Persisted {
  version: number;
  videoId: string;
  durationS: number | null;
  threshold: number | null;
  thresholdVersion: string | null;
  segments: AttentionSegment[];
  markers: AttentionMarker[];
  completed: boolean;
}

const AVAILABLE: ScoreAvailability = { state: 'available' };

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Convert a value on its declared scale to 0..100 attention (higher = attentive). */
export function toAttentionScore(value: number | null, scale: string): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (scale === 'score_0_100') return clamp(value, 0, 100);
  if (scale === 'loss_0_1') return clamp(100 * (1 - value), 0, 100);
  return null; // unknown scale: not plotted rather than guessed
}

export class AttentionTimelineStore {
  private readonly storage: KeyValueStorage | null;
  private readonly maxPoints: number;
  private readonly saveDelayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private videoId: string | null = null;
  private durationS: number | null = null;
  private threshold: number | null = null;
  private thresholdVersion: string | null = null;
  private segments: AttentionSegment[] = [];
  private markers: AttentionMarker[] = [];
  private completed = false;
  private availability: ScoreAvailability = AVAILABLE;
  private revision = 0;
  private seq = 0;
  private autoSegment = 0;
  private totalPoints = 0;
  private snapshot: TimelineSnapshot;
  private saveHandle: unknown = null;
  private readonly listeners = new Set<() => void>();
  private readonly markerListeners = new Set<(marker: AttentionMarker) => void>();

  constructor(options: StoreOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.maxPoints = options.maxPoints ?? 20_000;
    this.saveDelayMs = options.saveDelayMs ?? 2_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.snapshot = this.buildSnapshot();
  }

  // ---------- subscription (useSyncExternalStore-compatible) ----------

  getSnapshot = (): TimelineSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called once per genuinely new marker (not for markers restored from storage). */
  onMarkerAdded(listener: (marker: AttentionMarker) => void): () => void {
    this.markerListeners.add(listener);
    return () => this.markerListeners.delete(listener);
  }

  // ---------- lifecycle ----------

  /** Switch to a lecture, restoring its saved history. Idempotent for the same videoId. */
  open(videoId: string, durationS: number | null = null): void {
    if (this.videoId === videoId) {
      if (durationS !== null) this.setDuration(durationS);
      return;
    }
    this.flush();
    this.reset();
    this.videoId = videoId;
    const saved = this.load(videoId);
    if (saved) {
      this.durationS = saved.durationS;
      this.threshold = saved.threshold;
      this.thresholdVersion = saved.thresholdVersion;
      this.segments = saved.segments;
      this.markers = saved.markers;
      this.completed = saved.completed;
      this.totalPoints = this.segments.reduce((n, s) => n + s.points.length, 0);
      this.seq = this.segments.reduce((m, s) => Math.max(m, s.seq), 0);
    }
    if (durationS !== null) this.durationS = durationS;
    this.changed(false);
  }

  /** Close the current lecture (history stays saved). */
  close(): void {
    this.flush();
    this.reset();
    this.changed(false);
  }

  setDuration(durationS: number | null): void {
    if (durationS === null || !Number.isFinite(durationS) || durationS <= 0 || durationS === this.durationS) return;
    this.durationS = durationS;
    this.changed();
  }

  setAvailability(availability: ScoreAvailability): void {
    const same = availability.state === this.availability.state &&
      (availability.state === 'available' || (this.availability.state === 'unavailable' && this.availability.message === availability.message));
    if (same) return;
    this.availability = availability;
    this.changed(false);
  }

  /** Mark the lecture as finished; the summary stays available when the lecture is reopened. */
  markCompleted(): void {
    if (this.completed || !this.videoId) return;
    this.completed = true;
    this.changed();
  }

  /** Remove the saved history for the open lecture (or a given one). */
  clear(videoId: string | null = this.videoId): void {
    if (!videoId) return;
    try {
      this.storage?.removeItem(STORAGE_PREFIX + videoId);
    } catch {
      /* storage unavailable */
    }
    if (videoId === this.videoId) {
      const id = this.videoId;
      const duration = this.durationS;
      this.reset();
      this.videoId = id;
      this.durationS = duration;
      this.changed(false);
    }
  }

  /** Remove only Demo mode data from the open lecture. */
  clearSimulated(): void {
    const segments = this.segments.filter((s) => s.origin !== 'simulated');
    const markers = this.markers.filter((m) => m.origin !== 'simulated');
    if (segments.length === this.segments.length && markers.length === this.markers.length) return;
    this.segments = segments;
    this.markers = markers;
    this.totalPoints = segments.reduce((n, s) => n + s.points.length, 0);
    this.changed();
  }

  // ---------- input ----------

  /** Add one observation. Returns true if the timeline changed. */
  record(obs: AttentionObservation): boolean {
    if (!this.videoId || obs.videoId !== this.videoId) return false;
    const t = obs.mediaS ?? (obs.evidence ? obs.evidence.endMediaS : null);
    if (t === null || !Number.isFinite(t) || t < 0) return false; // no valid media mapping: drop

    const score = obs.valid ? toAttentionScore(obs.value, obs.scale) : null;
    const thr = obs.threshold === undefined || obs.threshold === null ? null : toAttentionScore(obs.threshold, obs.scale);
    if (thr !== null && (thr !== this.threshold || (obs.thresholdVersion ?? null) !== this.thresholdVersion)) {
      this.threshold = thr;
      this.thresholdVersion = obs.thresholdVersion ?? null;
    }
    const point: AttentionPoint = { t: round(t, 2), score, low: score !== null && this.threshold !== null && score <= this.threshold };

    const segment = this.segmentFor(obs, point.t);
    const last = segment.points[segment.points.length - 1];
    if (last && Math.floor(last.t) === Math.floor(point.t)) {
      if (last.score === point.score && last.low === point.low) return false;
      segment.points[segment.points.length - 1] = point;
    } else if (last && point.t < last.t) {
      return false; // out of order within one viewing
    } else {
      segment.points.push(point);
      this.totalPoints++;
      this.enforceBound();
    }
    this.touchSegment(segment);
    this.changed();
    return true;
  }

  /** Add or update a marker. Returns true for a new id (and notifies onMarkerAdded). */
  addMarker(marker: AttentionMarker): boolean {
    if (!this.videoId || !Number.isFinite(marker.startS)) return false;
    const i = this.markers.findIndex((m) => m.id === marker.id);
    if (i >= 0) {
      const old = this.markers[i]!;
      if (old.startS === marker.startS && old.endS === marker.endS && old.reason === marker.reason && old.score === marker.score) return false;
      this.markers = this.markers.map((m, j) => (j === i ? { ...old, ...marker } : m));
      this.changed();
      return false;
    }
    this.markers = [...this.markers, marker].sort((a, b) => a.startS - b.startS);
    this.changed();
    for (const l of this.markerListeners) l(marker);
    return true;
  }

  /** Replace the full set of markers from one source (e.g. the authoritative bookmark list). */
  syncMarkers(markers: readonly AttentionMarker[], belongs: (m: AttentionMarker) => boolean): void {
    const incoming = new Map(markers.map((m) => [m.id, m]));
    for (const m of markers) this.addMarker(m);
    const kept = this.markers.filter((m) => !belongs(m) || incoming.has(m.id));
    if (kept.length !== this.markers.length) {
      this.markers = kept;
      this.changed();
    }
  }

  // ---------- persistence ----------

  /** Write pending changes now (call on pagehide / lecture change). */
  flush(): void {
    if (this.saveHandle !== null) {
      this.clearTimer(this.saveHandle);
      this.saveHandle = null;
    }
    if (!this.videoId || !this.storage) return;
    const data: Persisted = {
      version: FORMAT_VERSION,
      videoId: this.videoId,
      durationS: this.durationS,
      threshold: this.threshold,
      thresholdVersion: this.thresholdVersion,
      segments: this.segments,
      markers: this.markers,
      completed: this.completed,
    };
    try {
      this.storage.setItem(STORAGE_PREFIX + this.videoId, JSON.stringify(data));
    } catch {
      /* quota or storage unavailable: history just won't persist */
    }
  }

  /** True when a finished lecture's summary is saved on this device. */
  static hasSavedSummary(videoId: string, storage: KeyValueStorage | null = defaultStorage()): boolean {
    try {
      const raw = storage?.getItem(STORAGE_PREFIX + videoId);
      return !!raw && (JSON.parse(raw) as Persisted).completed === true;
    } catch {
      return false;
    }
  }

  // ---------- internals ----------

  private load(videoId: string): Persisted | null {
    try {
      const raw = this.storage?.getItem(STORAGE_PREFIX + videoId);
      if (!raw) return null;
      const p = JSON.parse(raw) as Persisted;
      if (p?.version !== FORMAT_VERSION || p.videoId !== videoId || !Array.isArray(p.segments) || !Array.isArray(p.markers)) return null;
      const segments = p.segments.filter(isSegment).map((s) => ({ ...s, points: s.points.filter(isPoint) }));
      const markers = p.markers.filter(isMarker);
      return {
        ...p,
        durationS: finiteOrNull(p.durationS),
        threshold: finiteOrNull(p.threshold),
        thresholdVersion: typeof p.thresholdVersion === 'string' ? p.thresholdVersion : null,
        segments,
        markers,
        completed: p.completed === true,
      };
    } catch {
      return null;
    }
  }

  private segmentFor(obs: AttentionObservation, t: number): AttentionSegment {
    const base = `${obs.origin}|${obs.sessionId}|${obs.metric}`;
    if (obs.segmentId !== null) {
      const key = `${base}|${obs.segmentId}`;
      const found = this.findLatest((s) => s.key === key);
      if (found) return found;
      return this.newSegment(key, obs);
    }
    // No segment id from the source: start a new viewing on a jump backwards or a long skip.
    const prefix = `${base}|auto:`;
    const current = this.findLatest((s) => s.key.startsWith(prefix));
    const last = current?.points[current.points.length - 1];
    if (current && (!last || (t >= last.t - 1.5 && t <= last.t + 5))) return current;
    return this.newSegment(`${prefix}${++this.autoSegment}:${this.seq + 1}`, obs);
  }

  private findLatest(pred: (s: AttentionSegment) => boolean): AttentionSegment | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) if (pred(this.segments[i]!)) return this.segments[i];
    return undefined;
  }

  private newSegment(key: string, obs: AttentionObservation): AttentionSegment {
    const segment: AttentionSegment = { key, sessionId: obs.sessionId, segmentId: obs.segmentId, origin: obs.origin, metric: obs.metric, points: [], seq: ++this.seq };
    this.segments = [...this.segments, segment];
    return segment;
  }

  /** New object identity for a changed segment so memoised renderers can tell. */
  private touchSegment(segment: AttentionSegment) {
    const i = this.segments.indexOf(segment);
    if (i < 0) return;
    const copy = { ...segment };
    this.segments = this.segments.map((s, j) => (j === i ? copy : s));
  }

  private enforceBound() {
    while (this.totalPoints > this.maxPoints && this.segments.length) {
      const oldest = this.segments.reduce((a, b) => (a.seq <= b.seq ? a : b));
      const excess = this.totalPoints - this.maxPoints;
      if (oldest.points.length <= excess || this.segments.length > 1) {
        this.totalPoints -= oldest.points.length;
        this.segments = this.segments.filter((s) => s !== oldest);
      } else {
        oldest.points.splice(0, excess);
        this.totalPoints -= excess;
      }
    }
  }

  private reset() {
    this.videoId = null;
    this.durationS = null;
    this.threshold = null;
    this.thresholdVersion = null;
    this.segments = [];
    this.markers = [];
    this.completed = false;
    this.totalPoints = 0;
    this.seq = 0;
    this.autoSegment = 0;
  }

  private changed(persist = true) {
    this.revision++;
    this.snapshot = this.buildSnapshot();
    if (persist) this.scheduleSave();
    for (const l of this.listeners) l();
  }

  private scheduleSave() {
    if (!this.storage || this.saveHandle !== null) return;
    this.saveHandle = this.setTimer(() => {
      this.saveHandle = null;
      this.flush();
    }, this.saveDelayMs);
  }

  private buildSnapshot(): TimelineSnapshot {
    return {
      videoId: this.videoId,
      durationS: this.durationS,
      threshold: this.threshold,
      thresholdVersion: this.thresholdVersion,
      segments: this.segments,
      markers: this.markers,
      completed: this.completed,
      availability: this.availability,
      revision: this.revision,
    };
  }
}

// ---------- derived views (shared by live graph and summary) ----------

/** One value per media second, latest viewing wins. Gaps (null) are kept. */
export function latestSeries(snapshot: Pick<TimelineSnapshot, 'segments'>, origin: ObservationOrigin): AttentionPoint[] {
  const bySecond = new Map<number, AttentionPoint>();
  const ordered = snapshot.segments.filter((s) => s.origin === origin).sort((a, b) => a.seq - b.seq);
  for (const s of ordered) for (const p of s.points) bySecond.set(Math.floor(p.t), p);
  return [...bySecond.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/** Contiguous low-attention runs (gaps of up to `bridgeS` seconds between low points are bridged; a null point ends a run). */
export function lowRegions(snapshot: Pick<TimelineSnapshot, 'segments'>, bridgeS = 2): LowRegion[] {
  const out: LowRegion[] = [];
  for (const origin of ['measured', 'simulated'] as const) {
    let cur: LowRegion | null = null;
    for (const p of latestSeries(snapshot, origin)) {
      if (p.low && cur && p.t - cur.endS <= bridgeS) {
        cur.endS = p.t + 1;
        cur.minScore = minNullable(cur.minScore, p.score);
      } else if (p.low) {
        if (cur) out.push(cur);
        cur = { id: `${origin}:${Math.floor(p.t)}`, startS: p.t, endS: p.t + 1, minScore: p.score, origin };
      } else if (cur && (p.score === null || !p.low)) {
        out.push(cur);
        cur = null;
      }
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => a.startS - b.startS);
}

export function timelineStats(snapshot: TimelineSnapshot, origin: ObservationOrigin = 'measured'): TimelineStats {
  const series = latestSeries(snapshot, origin);
  let sum = 0;
  let n = 0;
  let unavailable = 0;
  let low = 0;
  let lowest: TimelineStats['lowest'] = null;
  for (const p of series) {
    if (p.score === null) {
      unavailable++;
      continue;
    }
    sum += p.score;
    n++;
    if (p.low) low++;
    if (!lowest || p.score < lowest.score) lowest = { t: p.t, score: p.score };
  }
  const markers = snapshot.markers.filter((m) => m.origin === origin);
  return {
    measuredSeconds: n,
    unavailablePoints: unavailable,
    average: n ? sum / n : null,
    lowest,
    lowSeconds: low,
    lowRegions: lowRegions(snapshot).filter((r) => r.origin === origin).length,
    reviewPoints: markers.filter((m) => m.kind === 'review').length,
    bookmarks: markers.filter((m) => m.kind === 'bookmark').length,
    hasSimulated: snapshot.segments.some((s) => s.origin === 'simulated') || snapshot.markers.some((m) => m.origin === 'simulated'),
  };
}

/** Frozen copy for the periodic (2-minute) graph refresh: later appends do not leak in. */
export function freezeSnapshot(snapshot: TimelineSnapshot): TimelineSnapshot {
  return { ...snapshot, segments: snapshot.segments.map((s) => ({ ...s, points: s.points.slice() })) };
}

// ---------- helpers ----------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const minNullable = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const finiteOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isPoint(p: unknown): p is AttentionPoint {
  const x = p as AttentionPoint;
  return !!x && typeof x.t === 'number' && Number.isFinite(x.t) && (x.score === null || (typeof x.score === 'number' && Number.isFinite(x.score))) && typeof x.low === 'boolean';
}
function isSegment(s: unknown): s is AttentionSegment {
  const x = s as AttentionSegment;
  return !!x && typeof x.key === 'string' && Array.isArray(x.points) && (x.origin === 'measured' || x.origin === 'simulated') && typeof x.seq === 'number';
}
function isMarker(m: unknown): m is AttentionMarker {
  const x = m as AttentionMarker;
  return !!x && typeof x.id === 'string' && (x.kind === 'review' || x.kind === 'bookmark') && typeof x.startS === 'number' && Number.isFinite(x.startS) && (x.origin === 'measured' || x.origin === 'simulated');
}
