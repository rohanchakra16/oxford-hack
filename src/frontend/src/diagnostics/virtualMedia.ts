/**
 * SYNTHETIC media element for the diagnostics harness: a deterministic play/pause/seek/rate/buffer
 * clock that emits the same events a real <video> would. Not a player; Person 4 owns the real one.
 */
import type { MediaEventName, MediaSnapshot, ReviewClient, Timers } from '../integration';

export class VirtualMedia {
  private anchorMs = 0;
  private anchorMedia = 0;
  private rate = 1;
  private playing = false;
  private buffering = false;
  private timer: number | null = null;
  segmentStartBrowserMs: number | null = null;
  segmentStartMediaS: number | null = null;

  constructor(
    private readonly client: ReviewClient,
    private readonly timers: Timers,
    readonly duration = 3600,
    private readonly onChange: () => void = () => {},
  ) {}

  position(): number {
    if (!this.playing || this.buffering) return this.anchorMedia;
    return Math.min(this.duration, this.anchorMedia + ((this.timers.now() - this.anchorMs) / 1000) * this.rate);
  }

  snapshot(overrides: Partial<MediaSnapshot> = {}): MediaSnapshot {
    return {
      currentTime: this.position(),
      playbackRate: this.rate,
      duration: this.duration,
      paused: !this.playing,
      seeking: false,
      ended: false,
      readyState: this.buffering ? 2 : 4,
      ...overrides,
    };
  }

  private emit(event: MediaEventName, overrides: Partial<MediaSnapshot> = {}): void {
    this.client.reportMediaEvent(event, this.snapshot(overrides));
    this.onChange();
  }

  private reanchor(): void {
    this.anchorMedia = this.position();
    this.anchorMs = this.timers.now();
  }

  private markSegment(): void {
    this.segmentStartBrowserMs = this.timers.now();
    this.segmentStartMediaS = this.anchorMedia;
  }

  load(): void {
    this.emit('loadedmetadata');
  }

  play(): void {
    if (this.playing) return;
    this.reanchor();
    this.playing = true;
    this.emit('play');
    this.markSegment();
    this.emit('playing');
    this.timer ??= this.timers.setInterval(() => {
      if (this.playing && !this.buffering) this.emit('timeupdate');
    }, 250);
  }

  pause(): void {
    if (!this.playing) return;
    this.reanchor();
    this.playing = false;
    this.segmentStartBrowserMs = null;
    this.emit('pause');
  }

  seek(mediaS: number): void {
    this.reanchor();
    this.segmentStartBrowserMs = null;
    this.emit('seeking', { seeking: true, currentTime: mediaS });
    this.anchorMedia = Math.max(0, Math.min(this.duration, mediaS));
    this.anchorMs = this.timers.now();
    if (this.playing) this.markSegment();
    this.emit('seeked');
  }

  setRate(rate: number): void {
    this.reanchor();
    this.rate = rate;
    if (this.playing) this.markSegment();
    this.emit('ratechange');
  }

  buffer(ms: number): void {
    if (!this.playing) return;
    this.reanchor();
    this.buffering = true;
    this.segmentStartBrowserMs = null;
    this.emit('waiting');
    this.timers.setTimeout(() => {
      this.anchorMs = this.timers.now();
      this.buffering = false;
      this.markSegment();
      this.emit('playing');
    }, ms);
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
