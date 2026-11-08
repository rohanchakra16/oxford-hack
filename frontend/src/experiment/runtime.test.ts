import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttentionTimelineStore } from '../attention/store';
import { ExperimentReplay, randomGaze, type ExperimentReading } from './runtime';
import { parseEegCsv } from './csv';

afterEach(() => vi.useRealTimers());

function fixture(score = 10) {
  vi.useFakeTimers();
  const store = new AttentionTimelineStore({ storage: null }); store.open('lecture', 100);
  const state = { mediaTimeS: 0, paused: false, seeking: false, buffering: false, ended: false };
  const random = vi.fn().mockReturnValue(.5);
  const report = vi.fn<(reading: ExperimentReading) => void>();
  const replay = parseEegCsv(`time_s,score\n${Array.from({ length: 60 }, (_, i) => `${i},${score}`).join('\n')}`);
  const runtime = new ExperimentReplay(store, { getState: () => state }, 'lecture', replay, report, random);
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
});
