import type { GazeObservation as ContractGazeObservation } from '../../frontend/src/contracts/generated/types';

/** Derived scalar window only. Camera frames and raw landmarks stay local. */
export interface GazeWindow {
  calibrationId: string;
  calibrationValid: boolean;
  validFraction: number;
  outsideFraction: number | null;
  windowMs: number;
  newestAgeMs: number;
  maxGapMs: number;
}

export class GazeWindowBuffer {
  private frames: ContractGazeObservation[] = [];
  private calibrationId: string | null = null;

  clear(calibrationId: string | null = null) {
    this.frames = [];
    this.calibrationId = calibrationId;
  }

  push(frame: ContractGazeObservation) {
    const previous = this.frames.at(-1);
    if (!Number.isFinite(frame.tBrowserFrameMs) || (previous && frame.tBrowserFrameMs <= previous.tBrowserFrameMs)) return;
    this.frames.push(frame);
    this.frames = this.frames.filter((f) => f.tBrowserFrameMs >= frame.tBrowserFrameMs - 3000).slice(-128);
  }

  read(now = performance.now()): GazeWindow | null {
    if (!this.calibrationId || document.hidden) return null;
    const start = now - 1000;
    const frames = this.frames.filter((f) => f.tBrowserFrameMs <= now);
    const latest = frames.at(-1);
    if (!latest) return null;
    let validMs = 0, outsideMs = 0;
    const first = frames.find((f) => f.tBrowserFrameMs >= start);
    let maxGapMs = first ? Math.max(0, first.tBrowserFrameMs - start) : 1000;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const stop = frames[i + 1]?.tBrowserFrameMs ?? now;
      if (stop <= start) continue;
      const gap = stop - frame.tBrowserFrameMs;
      maxGapMs = Math.max(maxGapMs, gap);
      if (gap > 250 || !frame.valid || frame.invalidReasons.length || frame.calibrationId !== this.calibrationId || frame.insideVideo === null) continue;
      const duration = Math.max(0, Math.min(stop, now) - Math.max(frame.tBrowserFrameMs, start));
      validMs += duration;
      if (!frame.insideVideo) outsideMs += duration;
    }
    return {
      calibrationId: this.calibrationId, calibrationValid: true,
      validFraction: validMs / 1000, outsideFraction: validMs ? outsideMs / validMs : null,
      windowMs: 1000, newestAgeMs: now - latest.tBrowserFrameMs, maxGapMs,
    };
  }
}
