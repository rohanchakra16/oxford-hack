import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttentionTimelineStore } from '../attention/store';
import { ExperimentReplay, randomGaze, type ExperimentReading } from './runtime';
import { parseEegCsv } from './csv';
import { GazeLiveStore, type GazeSample } from '../focus/gazeLive';

afterEach(() => vi.useRealTimers());

function fixture(score = 10, readWebcam?: () => GazeSample | null) {
  vi.useFakeTimers();
  const store = new AttentionTimelineStore({ storage: null }); store.open('lecture', 100);
  const state = { mediaTimeS: 0, paused: false, seeking: false, buffering: false, ended: false };
  const random = vi.fn().mockReturnValue(.5);
  const report = vi.fn<(reading: ExperimentReading) => void>();
  const replay = parseEegCsv(`time_s,score\n${Array.from({ length: 60 }, (_, i) => `${i},${score}`).join('\n')}`);
  const runtime = new ExperimentReplay(store, { getState: () => state }, 'lecture', replay, report, random, readWebcam);
  runtime.start();
  const advance = (seconds: number) => { for (let i = 0; i < seconds; i++) { state.mediaTimeS++; vi.advanceTimersByTime(1000); } };
  return { store, state, random, report, runtime, advance };
}

describe('experimental playback runtime', () => {
  it('randomizes gaze exactly every ten seconds and tears down both timers', () => {
    const f = fixture();
    expect(f.random).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(9999); expect(f.random).toHaveBeenCalledTimes(2);
    f.random.mockReturnValue(.95);
    vi.advanceTimersByTime(1); expect(f.random).toHaveBeenCalledTimes(4);
    expect(f.report.mock.lastCall![0].gaze.away).toBe(true);
    f.runtime.stop(); const calls = f.report.mock.calls.length;
    vi.advanceTimersByTime(30_000); expect(f.report).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records simulated combined scores and emits bounded low-score review dots', () => {
    const f = fixture(); f.advance(8);
    expect(f.store.getSnapshot().segments[0]!.origin).toBe('simulated');
    expect(f.store.getSnapshot().segments[0]!.points[0]!.score).toBe(28);
    expect(f.store.getSnapshot().markers).toHaveLength(1);
    f.advance(29); expect(f.store.getSnapshot().markers).toHaveLength(1);
    f.advance(1); expect(f.store.getSnapshot().markers).toHaveLength(2);
    f.runtime.stop();
  });

  it.each([
    [18.75, 35, true],
    [20, 36, false],
    [30, 44, false],
  ])('aligns low shading and review triggering for EEG %s (combined %s)', (eeg, combined, low) => {
    const f = fixture(eeg); f.advance(8);
    const snapshot = f.store.getSnapshot();
    expect(snapshot.threshold).toBe(35);
    expect(snapshot.thresholdVersion).toBe('csv-test-v2');
    expect(snapshot.segments[0]!.points[0]).toMatchObject({ score: combined, low });
    expect(snapshot.markers).toHaveLength(low ? 1 : 0);
    f.runtime.stop();
  });

  it('pause, buffering and seeks interrupt low dwell; rewind creates a new segment', () => {
    const f = fixture(); f.advance(5);
    f.state.paused = true; vi.advanceTimersByTime(5000);
    f.state.paused = false; f.advance(5);
    expect(f.store.getSnapshot().markers).toHaveLength(0);
    f.state.buffering = true; vi.advanceTimersByTime(500);
    f.state.buffering = false;
    f.state.mediaTimeS = 1; vi.advanceTimersByTime(500); f.advance(7);
    expect(f.store.getSnapshot().markers).toHaveLength(0);
    expect(f.store.getSnapshot().segments.length).toBeGreaterThan(1);
    f.advance(1); expect(f.store.getSnapshot().markers).toHaveLength(1);
    f.runtime.stop();
  });

  it('stops scoring at CSV end, reports unavailable and resumes after rewind', () => {
    const f = fixture(80); f.state.mediaTimeS = 60; vi.advanceTimersByTime(250);
    expect(f.report.mock.lastCall![0]).toMatchObject({ eeg: null, combined: null, ended: true });
    expect(f.store.getSnapshot().availability.state).toBe('unavailable');
    f.state.mediaTimeS = 0; vi.advanceTimersByTime(250);
    expect(f.report.mock.lastCall![0]).toMatchObject({ eeg: 80, combined: 84, ended: false });
    expect(f.store.getSnapshot().availability.state).toBe('available');
    f.runtime.stop();
  });

  it('classifies the generated coordinates against the mock video area', () => {
    expect(randomGaze(() => .5)).toEqual({ x: .5, y: .5, away: false });
    expect(randomGaze(() => .05).away).toBe(true);
  });

  it('combines measured webcam gaze with the CSV, without starting randomized gaze', () => {
    let sample: GazeSample = { state: 'on', tMs: 0, viewport: { x: 200, y: 100 }, pInside: .9, reason: null };
    const f = fixture(20, () => sample);
    expect(f.random).not.toHaveBeenCalled();
    expect(f.report.mock.lastCall![0]).toMatchObject({ combined: 36, gaze: { source: 'webcam', away: false } });
    sample = { ...sample, state: 'off', pInside: .01 };
    f.advance(9);
    expect(f.report.mock.lastCall![0].combined).toBe(16);
    expect(f.store.getSnapshot().markers).toHaveLength(1);
    expect(f.store.getSnapshot().markers[0]!.label).toContain('webcam');
    expect(f.store.getSnapshot().segments[0]!.origin).toBe('simulated');
    expect(f.random).not.toHaveBeenCalled();
    f.runtime.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['uncertain', 'lost', null] as const)('does not score or create markers for %s webcam gaze', (state) => {
    const f = fixture(10, () => state ? { state, tMs: 0, viewport: null, pInside: null, reason: null } : null);
    f.advance(12);
    expect(f.report.mock.lastCall![0]).toMatchObject({ eeg: 10, combined: null, gaze: { away: null } });
    expect(f.store.getSnapshot().availability.state).toBe('unavailable');
    expect(f.store.getSnapshot().markers).toHaveLength(0);
    f.runtime.stop();
  });

  it('expires stalled webcam samples rather than substituting randomized gaze', () => {
    const camera = new GazeLiveStore();
    const f = fixture(10, () => camera.fresh());
    camera.push({ state: 'off', tMs: 0, viewport: { x: 0, y: 0 }, pInside: 0, reason: null });
    vi.advanceTimersByTime(250);
    expect(f.report.mock.lastCall![0].combined).toBe(8);
    f.advance(3);
    expect(f.report.mock.lastCall![0].combined).toBeNull();
    expect(f.random).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().markers).toHaveLength(0);
    f.runtime.stop();
  });

  it('interrupts low dwell when gaze is lost and restored within one media second', () => {
    let sample: GazeSample | null = { state: 'off', tMs: 0, viewport: null, pInside: 0, reason: null };
    const f = fixture(10, () => sample);
    f.advance(5);
    sample = null; vi.advanceTimersByTime(250);
    sample = { state: 'off', tMs: 0, viewport: null, pInside: 0, reason: null };
    vi.advanceTimersByTime(250); f.advance(5);
    expect(f.store.getSnapshot().markers).toHaveLength(0);
    f.advance(4); expect(f.store.getSnapshot().markers).toHaveLength(1);
    f.runtime.stop();
  });
});
