import type { ScreenPoint } from "./types";

/**
 * Rolling median of recent gaze estimates over a time window. A median (not a mean) keeps
 * single-frame spikes from pulling the estimate across the video edge, which would otherwise
 * produce brief false "off_video" reports.
 */
export class PointSmoother {
  private buf: { t: number; p: ScreenPoint }[] = [];

  /** @param windowMs window length; 0 disables smoothing. @param maxGapMs a longer gap restarts the window. */
  constructor(
    private readonly windowMs: number,
    private readonly maxGapMs = 400,
  ) {}

  push(t: number, p: ScreenPoint): ScreenPoint {
    if (this.windowMs <= 0) return p;
    const last = this.buf[this.buf.length - 1];
    if (last && (t - last.t > this.maxGapMs || t < last.t)) this.buf = [];
    this.buf.push({ t, p });
    while (this.buf.length && this.buf[0].t <= t - this.windowMs) this.buf.shift();
    return { x: median(this.buf.map((b) => b.p.x)), y: median(this.buf.map((b) => b.p.y)) };
  }

  reset(): void {
    this.buf = [];
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
