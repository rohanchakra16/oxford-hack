import { describe, expect, it } from 'vitest';
import { ManualTimers } from '../timers';
import type { MediaSnapshot } from '../types';
import { SyntheticReviewClient } from './client';

const playing = (t: number): MediaSnapshot => ({
  currentTime: t, playbackRate: 1, duration: 600, paused: false, seeking: false, ended: false, readyState: 4,
});

function setup() {
  const timers = new ManualTimers(1000);
  const client = new SyntheticReviewClient({ timers });
  client.connect();
  client.startSession({ videoId: 'lecture-1', runKind: 'simulated', sensors: { eeg: true, gaze: true }, mediaDurationS: 600 });
  return { timers, client };
}

describe('SyntheticReviewClient', () => {
  it('is explicitly synthetic', () => {
    const { client } = setup();
    const s = client.getSnapshot();
    expect(s.kind).toBe('synthetic');
    expect(s.connection.detail).toMatch(/SYNTHETIC/);
    expect(s.session?.runKind).toBe('simulated');
  });

  it('creates schema-valid experimental bookmarks only during continuous playback', () => {
    const { timers, client } = setup();
    timers.advance(6000); // sensors become ok
    client.reportMediaEvent('playing', playing(100));
    timers.advance(30_000);
    const bookmarks = client.getSnapshot().bookmarks;
    expect(bookmarks).toHaveLength(1);
    const b = bookmarks[0]!;
    expect(b.source).toBe('experimental_combined');
    expect(b.evidenceMedia!.endMediaS).toBeCloseTo(124.8, 1);
    expect(b.suggestedMediaS).toBeCloseTo(b.evidenceMedia!.startMediaS - 2, 6);
    client.reportMediaEvent('pause', { ...playing(130), paused: true });
    timers.advance(60_000);
    expect(client.getSnapshot().bookmarks).toHaveLength(1);
    expect(client.getSnapshot().eligibility?.eligible).toBe(false);
  });

  it('keeps sensor unavailability separate from bookmarks', () => {
    const { timers, client } = setup();
    timers.advance(61_000);
    const s = client.getSnapshot().sensors!;
    expect(s.gaze.state).toBe('lost');
    expect(s.mode).toBe('eeg_only');
    expect(client.getSnapshot().bookmarks).toHaveLength(0);
  });

  it('adds manual bookmarks immediately and records feedback', () => {
    const { client } = setup();
    const id = client.markBookmark(42);
    expect(client.getSnapshot().bookmarks.map((b) => b.bookmarkId)).toEqual([id]);
    client.sendFeedback(id, 'dismiss', 40);
    expect(client.feedbackLog).toEqual([{ bookmarkId: id, action: 'dismiss', mediaTimeS: 40 }]);
  });

  it('clears session state on a new video and stops timers on dispose', () => {
    const { timers, client } = setup();
    client.markBookmark(1);
    client.startSession({ videoId: 'lecture-2', runKind: 'simulated', sensors: { eeg: true, gaze: false }, mediaDurationS: null });
    expect(client.getSnapshot().bookmarks).toHaveLength(0);
    let calls = 0;
    client.subscribe(() => calls++);
    client.dispose(); // notifies once that the connection closed, then drops listeners
    expect(client.getSnapshot().connection.state).toBe('closed');
    calls = 0;
    timers.advance(10_000);
    expect(calls).toBe(0);
  });
});
