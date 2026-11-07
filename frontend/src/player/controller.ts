/**
 * PlayerController: framework-free control and state for one <video> element.
 * Owner: Person 4 (@aryanmorarji). See src/player/README.md.
 *
 * Units: all times are media seconds (HTMLMediaElement.currentTime), never wall-clock.
 *
 * This class does NOT send telemetry. Telemetry goes through the integration layer
 * (attachMediaElement in LecturePlayer). The controller only reads the element and
 * performs user / review-UI requests (seek, replay a range, rate, volume).
 */

/** The subset of HTMLMediaElement the controller uses (lets tests use a fake). */
export interface MediaLike extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
}

export interface ReplayRange {
  startS: number;
  endS: number;
}

/** Immutable snapshot of the player. A new object on every change. */
export interface PlaybackStatus {
  /** Current position, media seconds. */
  mediaTimeS: number;
  /** Duration in media seconds, or null while unknown (no metadata, live/infinite). */
  durationS: number | null;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  /** True after `waiting` until frames advance again. */
  buffering: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  /** Active replayRange request, or null. Cleared when the range end is reached or on any other seek. */
  replay: ReplayRange | null;
}

/** Media element events the controller observes (for state and the optional event log). */
export const OBSERVED_EVENTS = [
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
  'volumechange',
  'timeupdate',
  'ended',
  'emptied',
  'error',
] as const;
export type ObservedEvent = (typeof OBSERVED_EVENTS)[number];

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

export class PlayerController {
  private status: PlaybackStatus;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: ObservedEvent, status: PlaybackStatus) => void>();
  private readonly detach: () => void;
  private replay: ReplayRange | null = null;
  /** Number of seeks started by replayRange that have not produced `seeking` yet. */
  private ownSeeksPending = 0;
  private buffering = false;
  private disposed = false;

  constructor(private readonly media: MediaLike) {
    this.status = this.read();
    const handlers = OBSERVED_EVENTS.map((name) => {
      const fn = () => this.onEvent(name);
      media.addEventListener(name, fn);
      return [name, fn] as const;
    });
    this.detach = () => {
      for (const [name, fn] of handlers) media.removeEventListener(name, fn);
    };
  }

  // ---- state ---------------------------------------------------------------

  getState = (): PlaybackStatus => this.status;

  /** For useSyncExternalStore. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Raw media events with the status after the event. Diagnostics/logging only. */
  onMediaEvent(listener: (event: ObservedEvent, status: PlaybackStatus) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ---- commands ------------------------------------------------------------

  play(): Promise<void> {
    return this.media.play();
  }

  pause(): void {
    this.media.pause();
  }

  togglePlay(): Promise<void> | void {
    return this.media.paused || this.media.ended ? this.play() : this.pause();
  }

  /** Jump to `timeS` (media seconds), clamped to [0, duration]. Cancels any active replay. */
  seek(timeS: number): void {
    if (!Number.isFinite(timeS)) throw new RangeError(`seek: time must be finite, got ${timeS}`);
    this.replay = null;
    this.media.currentTime = this.clamp(timeS);
    this.publish();
  }

  /**
   * Play [startS, endS) once, then pause at endS. Starts playback.
   * Any other seek (user or seek()) cancels the replay; pausing does not.
   * End detection uses `timeupdate` (about 4 Hz), so playback may run up to ~0.25 s past endS.
   */
  replayRange(startS: number, endS: number): Promise<void> {
    if (!Number.isFinite(startS) || !Number.isFinite(endS)) {
      return Promise.reject(new RangeError('replayRange: start and end must be finite'));
    }
    const start = this.clamp(startS);
    const end = this.clamp(endS);
    if (!(end > start)) {
      return Promise.reject(new RangeError(`replayRange: end (${endS}) must be after start (${startS})`));
    }
    this.replay = { startS: start, endS: end };
    this.ownSeeksPending += 1;
    this.media.currentTime = start;
    this.publish();
    return this.play();
  }

  cancelReplay(): void {
    if (!this.replay) return;
    this.replay = null;
    this.publish();
  }

  /** Clamped to [MIN_RATE, MAX_RATE]. */
  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.media.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  }

  /** 0..1 */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.media.volume = Math.min(1, Math.max(0, volume));
    if (this.media.volume > 0 && this.media.muted) this.media.muted = false;
  }

  setMuted(muted: boolean): void {
    this.media.muted = muted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.listeners.clear();
    this.eventListeners.clear();
  }

  // ---- internals -----------------------------------------------------------

  private clamp(t: number): number {
    const d = this.media.duration;
    const upper = Number.isFinite(d) && d > 0 ? d : Infinity;
    return Math.min(upper, Math.max(0, t));
  }

  private onEvent(name: ObservedEvent): void {
    switch (name) {
      case 'seeking':
        if (this.ownSeeksPending > 0) this.ownSeeksPending -= 1;
        else this.replay = null; // someone else moved the playhead
        break;
      case 'waiting':
      case 'stalled':
        if (!this.media.paused) this.buffering = true;
        break;
      case 'playing':
      case 'pause':
      case 'seeked':
      case 'ended':
        this.buffering = false;
        if (name === 'ended') this.replay = null;
        break;
      case 'emptied':
      case 'error':
        this.buffering = false;
        this.replay = null;
        this.ownSeeksPending = 0;
        break;
      case 'timeupdate':
        if (this.replay && !this.media.seeking && this.media.currentTime >= this.replay.endS) {
          this.replay = null;
          this.media.pause();
        }
        break;
      default:
        break;
    }
    this.publish();
    for (const l of [...this.eventListeners]) l(name, this.status);
  }

  private read(): PlaybackStatus {
    const m = this.media;
    const d = m.duration;
    return {
      mediaTimeS: m.currentTime,
      durationS: Number.isFinite(d) && d > 0 ? d : null,
      paused: m.paused,
      ended: m.ended,
      seeking: m.seeking,
      buffering: this.buffering,
      playbackRate: m.playbackRate,
      volume: m.volume,
      muted: m.muted,
      replay: this.replay,
    };
  }

  private publish(): void {
    const next = this.read();
    const prev = this.status;
    const same =
      prev.mediaTimeS === next.mediaTimeS &&
      prev.durationS === next.durationS &&
      prev.paused === next.paused &&
      prev.ended === next.ended &&
      prev.seeking === next.seeking &&
      prev.buffering === next.buffering &&
      prev.playbackRate === next.playbackRate &&
      prev.volume === next.volume &&
      prev.muted === next.muted &&
      prev.replay === next.replay;
    if (same) return;
    this.status = next;
    for (const l of [...this.listeners]) l();
  }
}
