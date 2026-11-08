import { describe, expect, it, vi } from 'vitest';
import { GazeLiveStore, type GazeSample } from './gazeLive';

const sample = (state: GazeSample['state'], extra: Partial<GazeSample> = {}): GazeSample => ({ tMs: 0, state, viewport: state === 'lost' ? null : { x: 10, y: 20 }, pInside: null, reason: null, ...extra });
const playing = (t: number) => ({ videoId: 'v1', mediaTimeS: t, paused: false });

describe('GazeLiveStore', () => {
  it('records gaze by lecture second and keeps unobserved seconds as gaps, never as looking away', () => {
    const store = new GazeLiveStore();
    store.push(sample('on'), playing(0.2)); store.push(sample('on'), playing(0.7));
    store.push(sample('off'), playing(1.1));
    store.push(sample('lost'), playing(3.4));
    expect(store.runs(5).map((r) => [r.startS, r.endS, r.state])).toEqual([[0, 1, 'on'], [1, 2, 'off'], [2, 3, 'none'], [3, 4, 'lost'], [4, 5, 'none']]);
    const { observedS, fractions } = store.summary(5);
    expect(observedS).toBe(3);
    expect(fractions).toEqual({ on: 1 / 3, off: 1 / 3, uncertain: 0, lost: 1 / 3 });
  });

  it('does not record while paused, and resets when the lecture changes', () => {
    const store = new GazeLiveStore();
    store.push(sample('on'), { videoId: 'v1', mediaTimeS: 2, paused: true });
    expect(store.hasData()).toBe(false);
    store.push(sample('on'), playing(2));
    expect(store.hasData()).toBe(true);
    store.push(sample('off'), { videoId: 'v2', mediaTimeS: 0, paused: false });
    expect(store.runs(1).map((r) => r.state)).toEqual(['off']);
  });

  it('reports no current sample once tracking stops or the latest one goes stale', () => {
    vi.useFakeTimers();
    const store = new GazeLiveStore();
    store.push(sample('on'), playing(0));
    expect(store.isActive()).toBe(true);
    expect(store.fresh()?.state).toBe('on');
    vi.advanceTimersByTime(2000);
    expect(store.fresh()).toBeNull(); // a stalled camera must not keep showing an old position
    store.push(null);
    expect(store.isActive()).toBe(false);
    vi.useRealTimers();
  });

  it('keeps no summary when nothing was observed', () => {
    expect(new GazeLiveStore().summary(10)).toEqual({ observedS: 0, fractions: null });
  });
});
