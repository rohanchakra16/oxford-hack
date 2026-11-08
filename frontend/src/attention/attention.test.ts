import { describe, expect, it, vi } from 'vitest';
import { AttentionTimelineStore, latestSeries, lowRegions, timelineStats, toAttentionScore, STORAGE_PREFIX, type KeyValueStorage } from './store';
import { markerFromBookmark, observationFromEvaluation, type EvaluationLike } from './adapters';
import { markerLanes, pathFor } from './AttentionGraph';
import { pushEvent } from './AttentionInfoIndicator';
import { AttentionDemo } from './demo';
import type { AttentionMarker, AttentionObservation } from './types';

class MemoryStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

const syncTimers = { setTimer: (fn: () => void) => { fn(); return 1; }, clearTimer: () => {} };

function obs(mediaS: number | null, value: number | null, extra: Partial<AttentionObservation> = {}): AttentionObservation {
  return {
    sessionId: 's1', videoId: 'v1', segmentId: 'seg1', evidence: null, mediaS,
    metric: 'attention_score', value, scale: 'score_0_100', valid: value !== null,
    origin: 'measured', provenance: 'test', threshold: 30, thresholdVersion: 't1', ...extra,
  };
}

function marker(id: string, startS: number, kind: AttentionMarker['kind'] = 'review'): AttentionMarker {
  return { id, kind, startS, endS: null, origin: 'measured', label: kind };
}

describe('toAttentionScore', () => {
  it('normalises known scales and refuses unknown ones', () => {
    expect(toAttentionScore(80, 'score_0_100')).toBe(80);
    expect(toAttentionScore(0.25, 'loss_0_1')).toBe(75);
    expect(toAttentionScore(140, 'score_0_100')).toBe(100);
    expect(toAttentionScore(1.2, 'logit')).toBeNull();
    expect(toAttentionScore(null, 'score_0_100')).toBeNull();
    expect(toAttentionScore(Number.NaN, 'score_0_100')).toBeNull();
  });
});

describe('AttentionTimelineStore', () => {
  it('records media-time points, one per second, and ignores other videos', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1', 600);
    expect(store.record(obs(10.2, 70))).toBe(true);
    expect(store.record(obs(10.8, 70))).toBe(false); // same second, same value
    expect(store.record(obs(10.9, 60))).toBe(true); // same second, replaced
    expect(store.record(obs(11.1, 65))).toBe(true);
    expect(store.record(obs(5, 65))).toBe(false); // out of order within a segment
    expect(store.record(obs(12, 50, { videoId: 'other' }))).toBe(false);
    const seg = store.getSnapshot().segments[0]!;
    expect(seg.points.map((p) => [Math.floor(p.t), p.score])).toEqual([[10, 60], [11, 65]]);
  });

  it('drops observations without a media mapping and stores invalid values as gaps, not zero', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    expect(store.record(obs(null, 50))).toBe(false);
    store.record(obs(1, 50));
    store.record(obs(2, 40, { valid: false }));
    store.record(obs(3, null));
    const points = store.getSnapshot().segments[0]!.points;
    expect(points.map((p) => p.score)).toEqual([50, null, null]);
    expect(points.some((p) => p.score === 0)).toBe(false);
  });

  it('uses evidence end when mediaS is absent', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    store.record(obs(null, 50, { evidence: { startMediaS: 4, endMediaS: 6 } }));
    expect(store.getSnapshot().segments[0]!.points[0]!.t).toBe(6);
  });

  it('keeps separate viewings distinct and lets the latest viewing win in the series', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    for (let t = 0; t < 10; t++) store.record(obs(t, 80));
    for (let t = 2; t < 6; t++) store.record(obs(t, 20, { segmentId: 'seg2' })); // rewatch
    const snap = store.getSnapshot();
    expect(snap.segments).toHaveLength(2);
    expect(snap.segments[0]!.points).toHaveLength(10); // first viewing preserved
    const series = latestSeries(snap, 'measured');
    expect(series.find((p) => Math.floor(p.t) === 3)!.score).toBe(20);
    expect(series.find((p) => Math.floor(p.t) === 8)!.score).toBe(80);
  });

  it('splits viewings on jumps when the source has no segment id', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    for (const t of [0, 1, 2, 3, 30, 31, 10, 11]) store.record(obs(t, 70, { segmentId: null }));
    expect(store.getSnapshot().segments.map((s) => s.points.length)).toEqual([4, 2, 2]);
  });

  it('marks low points against the threshold and derives low regions', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    const values = [80, 80, 25, 20, 22, 80, 80, 10, 10, 80];
    values.forEach((v, t) => store.record(obs(t, v)));
    const regions = lowRegions(store.getSnapshot(), 0);
    expect(regions.map((r) => [r.startS, r.endS, r.minScore])).toEqual([[2, 5, 20], [7, 9, 10]]);
    const stats = timelineStats(store.getSnapshot());
    expect(stats.lowSeconds).toBe(5);
    expect(stats.lowest).toEqual({ t: 7, score: 10 });
    expect(stats.average).toBeCloseTo(values.reduce((a, b) => a + b) / values.length);
  });

  it('a gap ends a low region', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    store.record(obs(0, 10));
    store.record(obs(1, null));
    store.record(obs(2, 10));
    expect(lowRegions(store.getSnapshot())).toHaveLength(2);
  });

  it('deduplicates markers by id and notifies only for new ones', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    const seen = vi.fn();
    store.onMarkerAdded(seen);
    expect(store.addMarker(marker('a', 5))).toBe(true);
    expect(store.addMarker(marker('a', 5))).toBe(false);
    expect(store.addMarker({ ...marker('a', 5), endS: 9 })).toBe(false); // update, not new
    expect(store.getSnapshot().markers[0]!.endS).toBe(9);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('syncMarkers removes markers that disappeared from their source only', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    store.addMarker(marker('demo', 1, 'bookmark'));
    store.syncMarkers([marker('b1', 5), marker('b2', 7)], (m) => m.id.startsWith('b'));
    store.syncMarkers([marker('b2', 7)], (m) => m.id.startsWith('b'));
    expect(store.getSnapshot().markers.map((m) => m.id)).toEqual(['demo', 'b2']);
  });

  it('persists per video, survives reopen, and does not re-notify restored markers', () => {
    const storage = new MemoryStorage();
    const a = new AttentionTimelineStore({ storage, ...syncTimers });
    a.open('v1', 300);
    a.record(obs(1, 50));
    a.addMarker(marker('m1', 1));
    a.markCompleted();
    a.open('v2');
    expect(storage.getItem(STORAGE_PREFIX + 'v1')).toBeTruthy();
    expect(AttentionTimelineStore.hasSavedSummary('v1', storage)).toBe(true);

    const b = new AttentionTimelineStore({ storage, ...syncTimers });
    const seen = vi.fn();
    b.onMarkerAdded(seen);
    b.open('v1');
    const snap = b.getSnapshot();
    expect(snap.completed).toBe(true);
    expect(snap.durationS).toBe(300);
    expect(snap.markers).toHaveLength(1);
    expect(snap.segments[0]!.points[0]!.score).toBe(50);
    expect(seen).not.toHaveBeenCalled();
    // continues the same viewing without duplicating
    b.record(obs(1.5, 50));
    expect(b.getSnapshot().segments[0]!.points).toHaveLength(1);
  });

  it('ignores malformed or old-format saved data', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_PREFIX + 'v1', '{not json');
    storage.setItem(STORAGE_PREFIX + 'v2', JSON.stringify({ version: 99, videoId: 'v2', segments: [], markers: [] }));
    storage.setItem(STORAGE_PREFIX + 'v3', JSON.stringify({ version: 1, videoId: 'v3', segments: [{ key: 'k', origin: 'measured', seq: 1, points: [{ t: 'x' }, { t: 2, score: 40, low: false }] }], markers: [{ id: 1 }] }));
    const store = new AttentionTimelineStore({ storage, ...syncTimers });
    store.open('v1');
    expect(store.getSnapshot().segments).toHaveLength(0);
    store.open('v2');
    expect(store.getSnapshot().segments).toHaveLength(0);
    store.open('v3');
    expect(store.getSnapshot().segments[0]!.points).toHaveLength(1);
    expect(store.getSnapshot().markers).toHaveLength(0);
  });

  it('is bounded: drops the oldest viewing first', () => {
    const store = new AttentionTimelineStore({ storage: null, maxPoints: 10 });
    store.open('v1');
    for (let t = 0; t < 6; t++) store.record(obs(t, 70, { segmentId: 'a' }));
    for (let t = 0; t < 6; t++) store.record(obs(t, 70, { segmentId: 'b' }));
    const segs = store.getSnapshot().segments;
    expect(segs.map((s) => s.segmentId)).toEqual(['b']);
    const single = new AttentionTimelineStore({ storage: null, maxPoints: 5 });
    single.open('v1');
    for (let t = 0; t < 8; t++) single.record(obs(t, 70));
    expect(single.getSnapshot().segments[0]!.points.map((p) => p.t)).toEqual([3, 4, 5, 6, 7]);
  });

  it('clear and clearSimulated', () => {
    const storage = new MemoryStorage();
    const store = new AttentionTimelineStore({ storage, ...syncTimers });
    store.open('v1');
    store.record(obs(1, 50));
    store.record(obs(1, 50, { origin: 'simulated', segmentId: 'd' }));
    store.addMarker({ ...marker('sim', 2), origin: 'simulated' });
    store.clearSimulated();
    expect(store.getSnapshot().segments.map((s) => s.origin)).toEqual(['measured']);
    expect(store.getSnapshot().markers).toHaveLength(0);
    store.clear();
    expect(store.getSnapshot().segments).toHaveLength(0);
    expect(storage.getItem(STORAGE_PREFIX + 'v1')).toBeNull();
  });

  it('separates simulated from measured statistics', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    store.record(obs(1, 90));
    store.record(obs(1, 10, { origin: 'simulated', segmentId: 'd' }));
    expect(timelineStats(store.getSnapshot(), 'measured').average).toBe(90);
    expect(timelineStats(store.getSnapshot(), 'simulated').average).toBe(10);
    expect(timelineStats(store.getSnapshot()).hasSimulated).toBe(true);
  });
});

describe('adapters', () => {
  const evaluation: EvaluationLike = {
    sessionId: 'e1', videoId: 'v1',
    status: { score: 55, state: 'ok' },
    config: { lowAttentionMax: 30 },
    fusion: { calibrated: true, combinedLoss: 0.2, threshold: 0.7, reason: '' },
  };
  const playing = { mediaTimeS: 12, paused: false, seeking: false, ended: false, replay: null };

  it('maps combined fusion loss and its threshold', () => {
    const o = observationFromEvaluation(evaluation, playing, 'seg')!;
    expect(o).toMatchObject({ metric: 'combined_loss', scale: 'loss_0_1', value: 0.2, valid: true, mediaS: 12, threshold: 0.7 });
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    store.record(o);
    expect(store.getSnapshot().threshold).toBeCloseTo(30);
    expect(store.getSnapshot().segments[0]!.points[0]!.score).toBeCloseTo(80);
  });

  it('uncalibrated fusion is a gap; EEG-only falls back to status.score', () => {
    expect(observationFromEvaluation({ ...evaluation, fusion: { ...evaluation.fusion!, calibrated: false } }, playing)!.valid).toBe(false);
    expect(observationFromEvaluation({ ...evaluation, fusion: null }, playing)).toMatchObject({ metric: 'eeg_score', value: 55, threshold: 30 });
  });

  it('skips paused, seeking, ended and replay ticks', () => {
    for (const p of [{ paused: true }, { seeking: true }, { ended: true }, { replay: { startS: 1, endS: 2 } }]) {
      expect(observationFromEvaluation(evaluation, { ...playing, ...p })).toBeNull();
    }
  });

  it('maps bookmarks: manual = bookmark, automatic = review, simulated labelled', () => {
    expect(markerFromBookmark({ bookmarkId: 'm', source: 'manual', suggestedMediaS: 3 })).toMatchObject({ kind: 'bookmark', origin: 'measured' });
    const r = markerFromBookmark({ bookmarkId: 'r', source: 'experimental_combined', suggestedMediaS: 9, endMediaS: 15, runKind: 'simulated' });
    expect(r).toMatchObject({ kind: 'review', origin: 'simulated', endS: 15 });
    expect(r.label).toMatch(/simulated/);
  });
});

describe('graph helpers', () => {
  it('breaks the path at gaps and jumps', () => {
    const d = pathFor(
      [{ t: 0, score: 50, low: false }, { t: 1, score: 60, low: false }, { t: 2, score: null, low: false }, { t: 3, score: 40, low: false }, { t: 10, score: 40, low: false }],
      (t) => t, (s) => s,
    );
    expect(d).toBe('M0.0 50.0L1.0 60.0M3.0 40.0M10.0 40.0');
  });

  it('info queue is newest-first, deduplicated and bounded', () => {
    let q: AttentionMarker[] = [];
    for (let i = 0; i < 7; i++) q = pushEvent(q, marker(`m${i}`, i));
    q = pushEvent(q, marker('m5', 5));
    expect(q.map((m) => m.id)).toEqual(['m5', 'm6', 'm4', 'm3', 'm2']);
  });
});

describe('AttentionDemo', () => {
  it('only produces simulated data, skips paused playback, and flags a sustained simulated drop', () => {
    const store = new AttentionTimelineStore({ storage: null });
    store.open('v1');
    const state = { mediaTimeS: 0, paused: false, seeking: false, ended: false, replay: null };
    const demo = new AttentionDemo(store, { subscribe: () => () => {}, getState: () => state }, { autoDipEveryS: 0 });
    demo.tick();
    state.paused = true;
    state.mediaTimeS = 1;
    demo.tick();
    expect(store.getSnapshot().segments[0]!.points).toHaveLength(1);
    state.paused = false;
    demo.triggerDip();
    for (let t = 1; t <= 20; t++) {
      state.mediaTimeS = t;
      demo.tick();
    }
    const snap = store.getSnapshot();
    expect(snap.segments.every((s) => s.origin === 'simulated')).toBe(true);
    const reviews = snap.markers.filter((m) => m.kind === 'review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.origin).toBe('simulated');
    expect(timelineStats(snap, 'measured').measuredSeconds).toBe(0);
  });
});

describe('markerLanes', () => {
  it('stacks markers closer than one head-width and reuses lanes once clear', () => {
    const sx = (t: number) => t * 10;
    const lanes = markerLanes(
      [
        { id: 'a', startS: 6 },
        { id: 'b', startS: 6.05 },
        { id: 'c', startS: 6.1 },
        { id: 'd', startS: 30 },
      ],
      sx,
    );
    expect([lanes.get('a'), lanes.get('b'), lanes.get('c'), lanes.get('d')]).toEqual([0, 1, 2, 0]);
  });
});
