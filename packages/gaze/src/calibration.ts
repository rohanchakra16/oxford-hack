import type { CalibrationQuality, FrameFeatures, ScreenPoint, ScreenRect } from "./types";

/** Features used for the screen mapping. Head pose + iris; deliberately small to avoid overfitting ~9 points. */
export const MAPPING_FEATURES = ["headYawDeg", "headPitchDeg", "irisX", "irisY"] as const;

export interface CalibrationPoint {
  /** Target position in screen CSS pixels. */
  target: ScreenPoint;
  /** Median features while the user looked at the target. */
  features: FrameFeatures;
  holdout: boolean;
}

export interface CalibrationModel {
  id: string;
  createdAtMs: number;
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
  fitRmsPx: number;
  heldoutErrorsPx: number[];
  heldoutRmsPx: number;
  /** Error margin used to mark estimates near the video edge as "uncertain". */
  marginPx: number;
  quality: CalibrationQuality;
  /** Head position at calibration time, used to detect when calibration goes stale. */
  baseline: { faceCenterX: number; faceCenterY: number; faceScale: number };
}

export interface FitOptions {
  /** Ridge penalty on standardised features (bias is not penalised). */
  lambda?: number;
  /** Video rect at calibration time; quality is judged relative to its size. */
  videoRect: ScreenRect;
  /** Never report a margin smaller than this (px), even if held-out error is tiny. */
  minMarginPx?: number;
  id?: string;
  nowMs?: number;
}

const toVector = (f: FrameFeatures) => MAPPING_FEATURES.map((k) => f[k]);

/** Solve A x = b for a small dense system (Gaussian elimination with partial pivoting). */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error("singular system");
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Ridge regression with an unpenalised bias. X rows are already standardised. */
export function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const d = X[0].length + 1;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    const row = [1, ...X[i]];
    for (let r = 0; r < d; r++) {
      b[r] += row[r] * y[i];
      for (let c = 0; c < d; c++) A[r][c] += row[r] * row[c];
    }
  }
  for (let r = 1; r < d; r++) A[r][r] += lambda;
  return solveLinear(A, b);
}

function standardise(v: number[], mean: number[], std: number[]): number[] {
  return v.map((x, i) => (x - mean[i]) / std[i]);
}

function dot(w: number[], v: number[]): number {
  return w[0] + v.reduce((s, x, i) => s + x * w[i + 1], 0);
}

export function predictScreen(model: CalibrationModel, f: FrameFeatures): ScreenPoint {
  const v = standardise(toVector(f), model.mean, model.std);
  return { x: dot(model.wx, v), y: dot(model.wy, v) };
}

const rms = (errs: number[]) =>
  errs.length ? Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length) : NaN;

export function fitCalibration(points: CalibrationPoint[], opts: FitOptions): CalibrationModel {
  const fit = points.filter((p) => !p.holdout);
  const held = points.filter((p) => p.holdout);
  if (fit.length < 6) throw new Error(`need at least 6 fitting points, got ${fit.length}`);
  if (held.length < 1) throw new Error("need at least 1 held-out point");

  const raw = fit.map((p) => toVector(p.features));
  const k = raw[0].length;
  const mean = Array.from({ length: k }, (_, j) => raw.reduce((s, r) => s + r[j], 0) / raw.length);
  const std = Array.from({ length: k }, (_, j) => {
    const sd = Math.sqrt(raw.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / raw.length);
    return sd > 1e-6 ? sd : 1;
  });
  const X = raw.map((r) => standardise(r, mean, std));
  const lambda = opts.lambda ?? 0.5;
  const wx = ridgeFit(X, fit.map((p) => p.target.x), lambda);
  const wy = ridgeFit(X, fit.map((p) => p.target.y), lambda);

  const partial = { mean, std, wx, wy } as CalibrationModel;
  const err = (p: CalibrationPoint) => {
    const q = predictScreen(partial, p.features);
    return Math.hypot(q.x - p.target.x, q.y - p.target.y);
  };
  const fitRmsPx = rms(fit.map(err));
  const heldoutErrorsPx = held.map(err);
  const heldoutRmsPx = rms(heldoutErrorsPx);

  const minDim = Math.min(opts.videoRect.width, opts.videoRect.height);
  const marginPx = Math.max(opts.minMarginPx ?? 40, 1.5 * heldoutRmsPx);
  const quality: CalibrationQuality =
    heldoutRmsPx <= 0.2 * minDim ? "fine" : heldoutRmsPx <= 0.6 * minDim ? "coarse" : "unusable";

  const avg = (key: "faceCenterX" | "faceCenterY" | "faceScale") =>
    fit.reduce((s, p) => s + p.features[key], 0) / fit.length;

  return {
    id: opts.id ?? `cal-${Math.random().toString(36).slice(2, 10)}`,
    createdAtMs: opts.nowMs ?? Date.now(),
    mean,
    std,
    wx,
    wy,
    fitRmsPx,
    heldoutErrorsPx,
    heldoutRmsPx,
    marginPx,
    quality,
    baseline: { faceCenterX: avg("faceCenterX"), faceCenterY: avg("faceCenterY"), faceScale: avg("faceScale") },
  };
}

/** Calibration targets as fractions of the video rect. Held-out points are interleaved so drift affects both sets. */
export const DEFAULT_TARGETS: { u: number; v: number; holdout: boolean }[] = [
  { u: 0.5, v: 0.5, holdout: false },
  { u: 0.1, v: 0.1, holdout: false },
  { u: 0.9, v: 0.1, holdout: false },
  { u: 0.3, v: 0.7, holdout: true },
  { u: 0.9, v: 0.9, holdout: false },
  { u: 0.1, v: 0.9, holdout: false },
  { u: 0.5, v: 0.1, holdout: false },
  { u: 0.7, v: 0.3, holdout: true },
  { u: 0.9, v: 0.5, holdout: false },
  { u: 0.5, v: 0.9, holdout: false },
  { u: 0.1, v: 0.5, holdout: false },
];

/**
 * Tracks whether the head has moved far enough from the calibration pose that
 * the mapping should no longer be trusted.
 */
export class StalenessTracker {
  private deviatingSinceMs: number | null = null;
  private expired = false;

  constructor(
    private readonly baseline: CalibrationModel["baseline"],
    private readonly opts = { maxShift: 0.12, maxScaleRatio: 1.25, graceMs: 1500, expireMs: 10000 },
  ) {}

  /** Returns "valid", "stale" (temporarily off-pose), or "expired" (needs recalibration). */
  update(f: FrameFeatures, nowMs: number): "valid" | "stale" | "expired" {
    if (this.expired) return "expired";
    const shift = Math.hypot(f.faceCenterX - this.baseline.faceCenterX, f.faceCenterY - this.baseline.faceCenterY);
    const ratio = f.faceScale / this.baseline.faceScale;
    const off =
      shift > this.opts.maxShift || ratio > this.opts.maxScaleRatio || ratio < 1 / this.opts.maxScaleRatio;
    if (!off) {
      this.deviatingSinceMs = null;
      return "valid";
    }
    this.deviatingSinceMs ??= nowMs;
    const dur = nowMs - this.deviatingSinceMs;
    if (dur >= this.opts.expireMs) {
      this.expired = true;
      return "expired";
    }
    return dur >= this.opts.graceMs ? "stale" : "valid";
  }
}
