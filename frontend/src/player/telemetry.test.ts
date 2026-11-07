/**
 * End-to-end check of the player's telemetry path, without a browser or backend:
 *   FakeMedia -> attachMediaElement (P5) -> reportMediaEvent -> PlaybackReporter (P5) -> PlaybackState
 * and every PlaybackState is validated against the shared contract schema.
 *
 * Reads P5's PlaybackReporter and validator directly, test-only, to observe the output the
 * backend would receive. Product code imports only from src/integration/index.ts.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type PlaybackState } from '../contracts/generated/types';
import { validateMessage } from '../contracts/validate';
import { attachMediaElement, type MediaEventName, type MediaSnapshot, type ReviewClient } from '../integration';
import { PlaybackReporter } from '../integration/playback/reporter';
import { PlayerController } from './controller';
import { FakeMedia } from './fakeMedia';

function setup() {
  const media = new FakeMedia();
  const sent: PlaybackState[] = [];
  let now = 0;
  const reporter = new PlaybackReporter('local-test', 'test', (s) => sent.push(s));
  const client = {
    reportMediaEvent: (e: MediaEventName, m: MediaSnapshot) => reporter.handle(e, m, now),
  } as unknown as ReviewClient;
  const controller = new PlayerController(media);
  attachMediaElement(client, media as unknown as HTMLMediaElement);
  const advance = (wallS: number, steps = 1) => {
    for (let i = 0; i < steps; i += 1) {
      now += (wallS * 1000) / steps;
      media.tick(wallS / steps);
    }
  };
  return { media, controller, sent, advance };
}

const summary = (s: PlaybackState) => `${s.event}/${s.state}@${s.mediaTimeS}${s.segmentId ? ` ${s.segmentId}` : ''}`;

describe('player telemetry through the shared integration layer', () => {
  it('every message satisfies the playback_state contract', async () => {
    const { media, controller, sent, advance } = setup();
    media.loadMetadata(600);
    await controller.play();
    advance(3, 12);
    controller.setPlaybackRate(1.5);
    advance(2, 8);
    media.stall();
    media.resume();
    controller.seek(300);
    controller.pause();
    await controller.replayRange(100, 105);
    advance(5, 20);
    expect(sent.length).toBeGreaterThan(5);
    sent.forEach((payload, i) => {
      const message = { schemaVersion: SCHEMA_VERSION, messageId: `msg-${i}`, sessionId: 'ses-test', seq: i + 1, type: 'playback_state', payload };
      expect(() => validateMessage(message), JSON.stringify(payload)).not.toThrow();
      // Cross-field rule the schema cannot express: segmentId is set iff state is playing.
      expect(payload.segmentId !== null).toBe(payload.state === 'playing');
    });
  });

  it('a seek during playback ends one segment and starts a new one', async () => {
    const { media, controller, sent, advance } = setup();
    media.loadMetadata(600);
    await controller.play();
    advance(2, 8);
    controller.seek(300);
    const playing = sent.filter((s) => s.state === 'playing' && s.event === 'playing');
    expect(playing.map((s) => s.segmentId)).toEqual(['test-seg-1', 'test-seg-2']);
    expect(sent.some((s) => s.event === 'seeking' && s.segmentId === null)).toBe(true);
    expect(playing[1]!.mediaTimeS).toBe(300);
  });

  it('pausing stops the segment; time spent paused is never reported as playing', async () => {
    const { media, controller, sent, advance } = setup();
    media.loadMetadata(600);
    await controller.play();
    advance(1, 4);
    controller.pause();
    const n = sent.length;
    advance(60, 10); // paused: media does not advance, no heartbeats
    expect(sent.length).toBe(n);
    expect(sent.at(-1)).toMatchObject({ event: 'pause', state: 'paused', segmentId: null });
  });

  it('a rate change starts a new segment carrying the new rate', async () => {
    const { media, controller, sent } = setup();
    media.loadMetadata(600);
    await controller.play();
    controller.setPlaybackRate(2);
    const last = sent.at(-1)!;
    expect(last).toMatchObject({ event: 'playing', playbackRate: 2, segmentId: 'test-seg-2' });
  });

  it('replayRange produces seek -> new segment at start -> pause at end', async () => {
    const { media, controller, sent, advance } = setup();
    media.loadMetadata(600);
    await controller.replayRange(100, 105);
    advance(5, 20);
    expect(sent.map(summary)).toEqual([
      'load/paused@0', // durationchange
      'load/paused@0', // loadedmetadata
      'seeking/seeking@0',
      'seeked/paused@100',
      'playing/playing@100 test-seg-1',
      'heartbeat/playing@101 test-seg-1',
      'heartbeat/playing@102 test-seg-1',
      'heartbeat/playing@103 test-seg-1',
      'heartbeat/playing@104 test-seg-1',
      // At 105 the controller pauses inside timeupdate, before the reporter's heartbeat.
      'pause/paused@105',
    ]);
  });

  it('a media error is reported as an error state', () => {
    const { media, sent } = setup();
    media.loadMetadata(600);
    media.fail();
    expect(sent.at(-1)).toMatchObject({ event: 'error', state: 'error' });
  });
});
