import { describe, expect, it } from 'vitest';
import { PlayerController } from './controller';
import { FakeMedia } from './fakeMedia';

function setup(durationS = 600) {
  const media = new FakeMedia();
  const c = new PlayerController(media);
  media.loadMetadata(durationS);
  return { media, c };
}

describe('PlayerController state', () => {
  it('reports unknown duration before metadata, then the real duration', () => {
    const media = new FakeMedia();
    const c = new PlayerController(media);
    expect(c.getState().durationS).toBeNull();
    media.loadMetadata(120);
    expect(c.getState().durationS).toBe(120);
  });

  it('returns the same snapshot object until something changes', () => {
    const { c } = setup();
    const a = c.getState();
    expect(c.getState()).toBe(a);
    c.seek(10);
    expect(c.getState()).not.toBe(a);
    expect(c.getState().mediaTimeS).toBe(10);
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const { c } = setup();
    let n = 0;
    const off = c.subscribe(() => (n += 1));
    c.seek(5);
    const after = n;
    expect(after).toBeGreaterThan(0);
    off();
    c.seek(6);
    expect(n).toBe(after);
  });

  it('tracks buffering from waiting until playing', () => {
    const { media, c } = setup();
    void c.play();
    media.stall();
    expect(c.getState().buffering).toBe(true);
    media.resume();
    expect(c.getState().buffering).toBe(false);
  });

  it('stops listening after dispose', () => {
    const { media, c } = setup();
    c.dispose();
    const before = c.getState();
    media.currentTime = 50;
    expect(c.getState()).toBe(before);
  });
});

describe('PlayerController commands', () => {
  it('clamps seek to [0, duration] and rejects non-finite times', () => {
    const { c } = setup(100);
    c.seek(-5);
    expect(c.getState().mediaTimeS).toBe(0);
    c.seek(500);
    expect(c.getState().mediaTimeS).toBe(100);
    expect(() => c.seek(NaN)).toThrow(RangeError);
  });

  it('clamps playback rate and volume', () => {
    const { c } = setup();
    c.setPlaybackRate(10);
    expect(c.getState().playbackRate).toBe(4);
    c.setPlaybackRate(0);
    expect(c.getState().playbackRate).toBe(0.25);
    c.setVolume(2);
    expect(c.getState().volume).toBe(1);
    c.setMuted(true);
    c.setVolume(0.5);
    expect(c.getState().muted).toBe(false);
  });

  it('togglePlay plays and pauses', () => {
    const { c } = setup();
    void c.togglePlay();
    expect(c.getState().paused).toBe(false);
    void c.togglePlay();
    expect(c.getState().paused).toBe(true);
  });
});

describe('PlayerController.replayRange', () => {
  it('seeks to start, plays, and pauses at the end of the range', async () => {
    const { media, c } = setup();
    await c.replayRange(100, 110);
    expect(c.getState()).toMatchObject({ mediaTimeS: 100, paused: false, replay: { startS: 100, endS: 110 } });
    for (let i = 0; i < 39; i += 1) media.tick(0.25); // 9.75 s
    expect(c.getState().paused).toBe(false);
    media.tick(0.25); // reaches 110
    expect(c.getState()).toMatchObject({ paused: true, replay: null });
    expect(media.currentTime).toBeCloseTo(110);
  });

  it('respects playback rate (2x reaches the end in half the wall time)', async () => {
    const { media, c } = setup();
    c.setPlaybackRate(2);
    await c.replayRange(0, 10);
    for (let i = 0; i < 20; i += 1) media.tick(0.25); // 5 s wall = 10 s media
    expect(c.getState()).toMatchObject({ paused: true, replay: null });
  });

  it('is cancelled by a user seek but not by pausing', async () => {
    const { media, c } = setup();
    await c.replayRange(100, 110);
    c.pause();
    expect(c.getState().replay).not.toBeNull();
    media.currentTime = 300; // e.g. keyboard or another component moved the playhead
    expect(c.getState().replay).toBeNull();
  });

  it('is cancelled by seek()', async () => {
    const { c } = setup();
    await c.replayRange(100, 110);
    c.seek(5);
    expect(c.getState().replay).toBeNull();
  });

  it('a second replay replaces the first', async () => {
    const { c } = setup();
    await c.replayRange(100, 110);
    await c.replayRange(200, 205);
    expect(c.getState().replay).toEqual({ startS: 200, endS: 205 });
  });

  it('rejects invalid ranges without changing playback', async () => {
    const { c } = setup(100);
    c.seek(42);
    await expect(c.replayRange(50, 50)).rejects.toThrow(RangeError);
    await expect(c.replayRange(60, 40)).rejects.toThrow(RangeError);
    await expect(c.replayRange(NaN, 10)).rejects.toThrow(RangeError);
    await expect(c.replayRange(150, 200)).rejects.toThrow(RangeError); // both clamp to 100
    expect(c.getState()).toMatchObject({ mediaTimeS: 42, replay: null });
  });

  it('is cleared by a media error', async () => {
    const { media, c } = setup();
    await c.replayRange(100, 110);
    media.fail();
    expect(c.getState().replay).toBeNull();
  });
});
