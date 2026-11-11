import type { ScreenPoint } from "./types";

/**
 * Rolling median of recent gaze estimates over a time window, optionally followed by an exponential
 * moving average. A median (not a mean) keeps single-frame spikes from pulling the estimate across
 * the video edge, which would otherwise produce brief false "off_video" reports. The EMA removes the
 * remaining frame-to-frame jumps of the median itself (it changes in steps as samples enter and leave
 * the window), which made the on-screen crosshair look jittery and the on/off decision flicker.
 */
export class PointSmoother {
  private buf: { t: number; p: ScreenPoint }[] = [];
  private ema: { t: number; p: ScreenPoint } | null = null;

  /**
   * @param windowMs median window length; 0 disables smoothing.
   * @param maxGapMs a longer gap restarts the window.
   * @param emaTauMs time constant of the EMA applied after the median; 0 disables it.
   */
  constructor(
    private readonly windowMs: number,
    private readonly maxGapMs = 400,
    private readonly emaTauMs = 0,
  ) {}

  push(t: number, p: ScreenPoint): ScreenPoint {
    if (this.windowMs <= 0) return p;
    const last = this.buf[this.buf.length - 1];
    if (last && (t - last.t > this.maxGapMs || t < last.t)) this.reset();
    this.buf.push({ t, p });
    while (this.buf.length && this.buf[0].t <= t - this.windowMs) this.buf.shift();
    const m = { x: median(this.buf.map((b) => b.p.x)), y: median(this.buf.map((b) => b.p.y)) };
    if (this.emaTauMs <= 0) return m;
    if (!this.ema) {
      this.ema = { t, p: m };
    } else {
      // Time-based weight, so the response doesn't depend on the frame rate.
      const a = 1 - Math.exp(-Math.max(0, t - this.ema.t) / this.emaTauMs);
      this.ema = { t, p: { x: this.ema.p.x + a * (m.x - this.ema.p.x), y: this.ema.p.y + a * (m.y - this.ema.p.y) } };
    }
    return this.ema.p;
  }

  /** The latest smoothed estimate, without adding a sample (e.g. during a partial blink). Null if none. */
  current(): ScreenPoint | null {
    if (this.ema) return this.ema.p;
    if (!this.buf.length) return null;
    return { x: median(this.buf.map((b) => b.p.x)), y: median(this.buf.map((b) => b.p.y)) };
  }

  reset(): void {
    this.buf = [];
    this.ema = null;
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
