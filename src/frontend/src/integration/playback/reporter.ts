/**
 * Turns media element events into PlaybackState telemetry. Owner: Person 5 (segment semantics are
 * part of the timing contract). Person 4's player forwards events via ReviewClient.reportMediaEvent.
 *
 * Rules (docs/TIMING.md):
 * - A new segmentId whenever frames start advancing after any interruption, including rate changes.
 * - Heartbeats are driven by `timeupdate` (at most one per heartbeatMs) and carry that event's time,
 *   so a throttled/hidden tab produces stale telemetry instead of invented positions.
 * - `play` is intent, not playback: it is ignored. `playing` (or `seeked` while unpaused) starts a segment.
 */
import type { PlaybackState } from '../../contracts/generated/types';
import type { MediaEventName, MediaSnapshot } from '../types';

type StateName = PlaybackState['state'];
type EventName = PlaybackState['event'];

const HAVE_FUTURE_DATA = 3;

export class PlaybackReporter {
  private seq = 0;
  private segN = 0;
  private segmentId: string | null = null;
  private lastSentMs = -Infinity;
  private last: MediaSnapshot | null = null;
  private loaded = false;

  constructor(
    private readonly videoId: string,
    private readonly idPrefix: string,
    private readonly send: (state: PlaybackState) => void,
    private readonly heartbeatMs = 1000,
  ) {}

  get currentSegmentId(): string | null {
    return this.segmentId;
  }

  get lastMedia(): MediaSnapshot | null {
    return this.last;
  }

  handle(event: MediaEventName, media: MediaSnapshot, tBrowserMs: number): void {
    this.last = media;
    switch (event) {
      case 'play':
        return; // intent only
      case 'loadedmetadata':
      case 'durationchange':
        if (event === 'loadedmetadata') this.loaded = true;
        if (!this.segmentId) this.emit('load', media.paused ? 'paused' : 'loading', media, tBrowserMs);
        return;
      case 'emptied':
        this.segmentId = null;
        if (this.loaded) this.emit('source_change', 'loading', media, tBrowserMs);
        this.loaded = false;
        return;
      case 'playing':
        this.startSegment(media, tBrowserMs);
        return;
      case 'seeked':
        if (!media.paused && media.readyState >= HAVE_FUTURE_DATA) this.startSegment(media, tBrowserMs);
        else this.emit('seeked', media.paused ? 'paused' : 'buffering', media, tBrowserMs);
        return;
      case 'pause':
        this.stop('pause', 'paused', media, tBrowserMs);
        return;
      case 'seeking':
        this.stop('seeking', 'seeking', media, tBrowserMs);
        return;
      case 'waiting':
      case 'stalled':
        if (event === 'stalled' && !this.segmentId) return;
        this.stop('waiting', 'buffering', media, tBrowserMs);
        return;
      case 'ended':
        this.stop('ended', 'ended', media, tBrowserMs);
        return;
      case 'error':
        this.stop('error', 'error', media, tBrowserMs);
        return;
      case 'ratechange':
        if (this.segmentId) this.startSegment(media, tBrowserMs);
        else this.emit('ratechange', media.paused ? 'paused' : 'buffering', media, tBrowserMs);
        return;
      case 'timeupdate':
        if (this.segmentId && !media.paused && !media.seeking) {
          if (tBrowserMs - this.lastSentMs >= this.heartbeatMs) this.emit('heartbeat', 'playing', media, tBrowserMs);
        } else if (!this.segmentId && !media.paused && !media.seeking && media.readyState >= HAVE_FUTURE_DATA) {
          // Recovered from buffering without a 'playing' event.
          this.startSegment(media, tBrowserMs);
        }
        return;
    }
  }

  /** After a reconnect: start a fresh segment if playing, so no gap is bridged. */
  resync(tBrowserMs: number): void {
    const media = this.last;
    if (!media) return;
    if (!media.paused && !media.seeking && !media.ended) this.startSegment(media, tBrowserMs);
    else this.emit('heartbeat', media.ended ? 'ended' : 'paused', media, tBrowserMs);
  }

  private startSegment(media: MediaSnapshot, t: number): void {
    this.segN += 1;
    this.segmentId = `${this.idPrefix}-seg-${this.segN}`;
    this.emit('playing', 'playing', media, t);
  }

  private stop(event: EventName, state: StateName, media: MediaSnapshot, t: number): void {
    this.segmentId = null;
    this.emit(event, state, media, t);
  }

  private emit(event: EventName, state: StateName, media: MediaSnapshot, t: number): void {
    this.seq += 1;
    this.lastSentMs = t;
    this.send({
      videoId: this.videoId,
      segmentId: state === 'playing' ? this.segmentId : null,
      event,
      state,
      tBrowserMs: Math.max(0, t),
      mediaTimeS: Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0,
      playbackRate: media.playbackRate > 0 ? media.playbackRate : 1,
      mediaDurationS: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null,
      telemetrySeq: this.seq,
    });
  }
}

/** Snapshot an HTMLMediaElement for reportMediaEvent. */
export function mediaSnapshot(el: HTMLMediaElement): MediaSnapshot {
  return {
    currentTime: el.currentTime,
    playbackRate: el.playbackRate,
    duration: el.duration,
    paused: el.paused,
    seeking: el.seeking,
    ended: el.ended,
    readyState: el.readyState,
  };
}

export const MEDIA_EVENTS: readonly MediaEventName[] = [
  'loadedmetadata',
  'durationchange',
  'play',
  'playing',
  'pause',
  'seeking',
  'seeked',
  'waiting',
  'stalled',
  'ratechange',
  'ended',
  'emptied',
  'error',
  'timeupdate',
];
