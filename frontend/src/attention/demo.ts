/**
 * Demo mode (#55): SIMULATED attention data for presenting the UI without deliberately losing focus.
 * Isolated from real processing: it only calls the store's public API, every value is tagged
 * origin 'simulated' / provenance 'demo-mode', and it never touches the review client, the
 * detector or the transport. Simulated points are never reused as real data.
 */
import type { AttentionTimelineStore } from './store';

export interface DemoPlayback {
  subscribe(listener: () => void): () => void;
  getState(): { mediaTimeS: number; paused: boolean; seeking: boolean; ended: boolean; replay: unknown | null };
}

export interface DemoOptions {
  /** Simulated threshold on the 0..100 scale. */
  threshold?: number;
  /** Seconds of sustained low score before a simulated review point. */
  dwellS?: number;
  /** Media seconds between automatic simulated dips (0 = only on demand). */
  autoDipEveryS?: number;
  tickMs?: number;
}

export const DEMO_PROVENANCE = 'demo-mode';

/** Deterministic, smooth baseline so a rehearsal looks the same each time. */
export function demoBaseline(t: number): number {
  return 74 + 9 * Math.sin(t / 37) + 5 * Math.sin(t / 11 + 1.3) + 2 * Math.sin(t / 3.1);
}

export class AttentionDemo {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dipStartS: number | null = null;
  private lowSinceS: number | null = null;
  private flagged = false;
  private readonly sessionId = `demo-${Math.random().toString(36).slice(2, 10)}`;
  private segment = 0;
  private lastT: number | null = null;
  private nextAutoDipS: number;
  private readonly opts: Required<DemoOptions>;

  constructor(private readonly store: AttentionTimelineStore, private readonly playback: DemoPlayback, options: DemoOptions = {}) {
    this.opts = { threshold: 35, dwellS: 6, autoDipEveryS: 150, tickMs: 1000, ...options };
    this.nextAutoDipS = this.opts.autoDipEveryS || Infinity;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start a simulated low-attention episode at the current playback position. */
  triggerDip() {
    this.dipStartS = this.playback.getState().mediaTimeS;
    this.flagged = false;
  }

  /** Add a simulated manual-style bookmark at the current position (labelled simulated). */
  addBookmark() {
    const t = this.playback.getState().mediaTimeS;
    this.store.addMarker({
      id: `${this.sessionId}:bookmark:${Math.round(t * 10)}`,
      kind: 'bookmark',
      startS: t,
      endS: null,
      origin: 'simulated',
      label: 'Bookmark (simulated)',
      reason: 'Demo mode example bookmark. Not created by the viewer.',
    });
  }

  /** One simulated sample. Public for tests. */
  tick() {
    const s = this.playback.getState();
    if (s.paused || s.seeking || s.ended || s.replay !== null) return;
    const t = s.mediaTimeS;
    if (this.lastT !== null && (t < this.lastT - 1.5 || t > this.lastT + 5)) this.segment++; // seek = new viewing
    this.lastT = t;

    if (this.opts.autoDipEveryS && t >= this.nextAutoDipS && this.dipStartS === null) {
      this.triggerDip();
      this.nextAutoDipS = t + this.opts.autoDipEveryS;
    }
    let score = demoBaseline(t);
    if (this.dipStartS !== null) {
      const into = t - this.dipStartS;
      const len = 14;
      if (into < 0 || into > len + 4) {
        this.dipStartS = null;
      } else {
        // smooth drop to ~20, hold, recover
        const depth = into < 3 ? into / 3 : into < len ? 1 : Math.max(0, 1 - (into - len) / 4);
        score = score - depth * (score - 20);
      }
    }
    this.store.record({
      sessionId: this.sessionId,
      videoId: this.store.getSnapshot().videoId ?? '',
      segmentId: `demo-${this.segment}`,
      evidence: { startMediaS: Math.max(0, t - 1), endMediaS: t },
      mediaS: t,
      metric: 'demo_attention',
      value: score,
      scale: 'score_0_100',
      valid: true,
      origin: 'simulated',
      provenance: DEMO_PROVENANCE,
      threshold: this.opts.threshold,
      thresholdVersion: 'demo',
    });

    if (score <= this.opts.threshold) {
      this.lowSinceS ??= t;
      if (!this.flagged && t - this.lowSinceS >= this.opts.dwellS) {
        this.flagged = true;
        this.store.addMarker({
          id: `${this.sessionId}:review:${Math.round(this.lowSinceS)}`,
          kind: 'review',
          startS: this.lowSinceS,
          endS: t,
          origin: 'simulated',
          label: 'Review point (simulated)',
          reason: `Demo mode: the simulated score stayed below ${this.opts.threshold} for ${this.opts.dwellS} s. Not a real measurement.`,
          score: Math.round(score),
        });
      }
    } else {
      this.lowSinceS = null;
      if (this.dipStartS === null) this.flagged = false;
    }
  }
}
