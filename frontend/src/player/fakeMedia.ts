/**
 * Test double for HTMLMediaElement (Person 4). Vitest runs in Node (no DOM), so player tests
 * drive this fake instead of a real <video>. It dispatches the same events, in the same order,
 * as a browser for the operations the player uses. Seeks complete synchronously.
 */
import type { MediaLike } from './controller';

export class FakeMedia extends EventTarget implements MediaLike {
  private _time = 0;
  private _rate = 1;
  private _volume = 1;
  private _muted = false;
  duration = NaN;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;

  get currentTime(): number {
    return this._time;
  }
  set currentTime(t: number) {
    this.seeking = true;
    this.ended = false;
    this.fire('seeking');
    this._time = t;
    this.seeking = false;
    this.fire('seeked');
  }

  get playbackRate(): number {
    return this._rate;
  }
  set playbackRate(r: number) {
    this._rate = r;
    this.fire('ratechange');
  }

  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = v;
    this.fire('volumechange');
  }

  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.fire('volumechange');
  }

  /** Simulate metadata arriving for a file of `durationS`. */
  loadMetadata(durationS: number): void {
    this.duration = durationS;
    this.readyState = 4;
    this.fire('durationchange');
    this.fire('loadedmetadata');
  }

  play(): Promise<void> {
    if (this.paused) {
      this.paused = false;
      if (this.ended) {
        this.ended = false;
        this._time = 0;
      }
      this.fire('play');
      if (this.readyState >= 3) this.fire('playing');
      else this.fire('waiting');
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }

  /** Advance playback by `wallS` seconds of real time (media advances wallS * rate). */
  tick(wallS: number): void {
    if (this.paused || this.seeking) return;
    this._time = Math.min(this.duration, this._time + wallS * this._rate);
    this.fire('timeupdate');
    if (this._time >= this.duration) {
      this.paused = true;
      this.ended = true;
      this.fire('pause');
      this.fire('ended');
    }
  }

  /** Simulate a stall (network or decode). */
  stall(): void {
    this.readyState = 2;
    this.fire('waiting');
  }

  resume(): void {
    this.readyState = 4;
    if (!this.paused) this.fire('playing');
  }

  fail(): void {
    this.fire('error');
  }

  private fire(name: string): void {
    this.dispatchEvent(new Event(name));
  }
}
