import { describe, expect, it } from 'vitest';
import type { PlaybackState } from '../../contracts/generated/types';
import { validateMessage } from '../../contracts/validate';
import type { MediaSnapshot } from '../types';
import { PlaybackReporter } from './reporter';

function media(p: Partial<MediaSnapshot> = {}): MediaSnapshot {
  return { currentTime: 0, playbackRate: 1, duration: 600, paused: true, seeking: false, ended: false, readyState: 4, ...p };
}

function setup() {
  const sent: PlaybackState[] = [];
  const r = new PlaybackReporter('video-1', 'c1', (s) => sent.push(s));
  return { r, sent };
}

describe('PlaybackReporter', () => {
  it('ignores play intent and starts a segment on playing', () => {
    const { r, sent } = setup();
    r.handle('play', media(), 100);
    expect(sent).toHaveLength(0);
    r.handle('playing', media({ paused: false, currentTime: 10 }), 120);
    expect(sent[0]).toMatchObject({ event: 'playing', state: 'playing', segmentId: 'c1-seg-1', mediaTimeS: 10 });
  });

  it('sends heartbeats from timeupdate at most once per second', () => {
    const { r, sent } = setup();
    r.handle('playing', media({ paused: false }), 0);
    for (let t = 250; t <= 2000; t += 250) r.handle('timeupdate', media({ paused: false, currentTime: t / 1000 }), t);
    expect(sent.filter((s) => s.event === 'heartbeat').map((s) => s.tBrowserMs)).toEqual([1000, 2000]);
  });

  it('ends the segment on pause, seek and buffering, and starts a new one afterwards', () => {
    const { r, sent } = setup();
    r.handle('playing', media({ paused: false }), 0);
    r.handle('seeking', media({ paused: false, seeking: true, currentTime: 50 }), 100);
    r.handle('seeked', media({ paused: false, currentTime: 50 }), 150);
    r.handle('waiting', media({ paused: false, currentTime: 50, readyState: 2 }), 200);
    r.handle('playing', media({ paused: false, currentTime: 50 }), 400);
    r.handle('pause', media({ currentTime: 51 }), 1400);
    expect(sent.map((s) => [s.event, s.state, s.segmentId])).toEqual([
      ['playing', 'playing', 'c1-seg-1'],
      ['seeking', 'seeking', null],
      ['playing', 'playing', 'c1-seg-2'],
      ['waiting', 'buffering', null],
      ['playing', 'playing', 'c1-seg-3'],
      ['pause', 'paused', null],
    ]);
  });

  it('starts a new segment on a rate change during playback', () => {
    const { r, sent } = setup();
    r.handle('playing', media({ paused: false }), 0);
    r.handle('ratechange', media({ paused: false, playbackRate: 1.5, currentTime: 3 }), 3000);
    expect(sent[1]).toMatchObject({ segmentId: 'c1-seg-2', playbackRate: 1.5 });
  });

  it('reports a source change and never emits non-finite values', () => {
    const { r, sent } = setup();
    r.handle('loadedmetadata', media({ duration: Number.NaN }), 0);
    r.handle('emptied', media({ currentTime: Number.NaN, duration: Number.POSITIVE_INFINITY }), 10);
    expect(sent.map((s) => s.event)).toEqual(['load', 'source_change']);
    expect(sent[1]).toMatchObject({ mediaTimeS: 0, mediaDurationS: null });
  });

  it('produces messages that pass the shared schema, with increasing telemetrySeq', () => {
    const { r, sent } = setup();
    r.handle('loadedmetadata', media(), 0);
    r.handle('playing', media({ paused: false }), 10);
    r.handle('pause', media({ currentTime: 1 }), 1010);
    sent.forEach((payload, i) => {
      expect(() =>
        validateMessage({ schemaVersion: '0.1.0', messageId: `m${i}`, sessionId: 's', seq: i, type: 'playback_state', payload }),
      ).not.toThrow();
    });
    expect(sent.map((s) => s.telemetrySeq)).toEqual([1, 2, 3]);
  });
});
