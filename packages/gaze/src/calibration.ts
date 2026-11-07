import type { CalibrationQuality, FrameFeatures, ScreenPoint, ScreenRect } from "./types";

export type FeatureKey = keyof FrameFeatures;

/** Static dots: ~9 fitted points, so keep the model small (4 features + bias). */
export const DOT_FEATURES: FeatureKey[] = ["headYawDeg", "headPitchDeg", "irisX", "irisY"];
/**
 * Moving dot: hundreds of samples, so we can also use where the face sits in the camera image.
 * Head translation shifts the gaze point even at a constant head angle.
 */
export const PURSUIT_FEATURES: FeatureKey[] = [
  "headYawDeg",
  "headPitchDeg",
  "irisX",
  "irisY",
  "faceCenterX",
  "faceCenterY",
  "faceScale",
];

/** @deprecated kept for calibrations saved before featureKeys existed. */
export const MAPPING_FEATURES = DOT_FEATURES;

export interface CalibrationSample {
  /** Target position in screen CSS pixels. */
  target: ScreenPoint;
  features: FrameFeatures;
  /**
   * Samples sharing a group are correlated (one dot, or one time block of the moving dot).
   * Held-out error is computed per group so many correlated samples can't inflate confidence.
   */
  group: string;
  holdout: boolean;
}

/** @deprecated alias; a static-dot calibration point is just a one-sample group. */
export type CalibrationPoint = CalibrationSample;

export type CalibrationMethod = "dots" | "pursuit";

export interface CalibrationModel {
  id: string;
  createdAtMs: number;
  method: CalibrationMethod;
  featureKeys: FeatureKey[];
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
  /** Eye lag behind a moving target used when fitting (ms); 0 for static dots. */
  lagMs: number;
  fitSamples: number;
  fitRmsPx: number;
  /** One error per held-out group (mean over that group's samples). */
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
  featureKeys?: FeatureKey[];
  method?: CalibrationMethod;
  lagMs?: number;
  /** Never report a margin smaller than this (px), even if held-out error is tiny. */
  minMarginPx?: number;
  id?: string;
  nowMs?: number;
}

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

type Mapping = Pick<CalibrationModel, "mean" | "std" | "wx" | "wy"> & { featureKeys?: FeatureKey[] };

export function predictScreen(model: Mapping, f: FrameFeatures): ScreenPoint {
  const keys = model.featureKeys ?? DOT_FEATURES;
  const v = standardise(keys.map((k) => f[k]), model.mean, model.std);
  return { x: dot(model.wx, v), y: dot(model.wy, v) };
}

const rms = (errs: number[]) =>
  errs.length ? Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length) : NaN;

/** Fit the screen mapping on non-held-out samples only. */
function fitMapping(fit: CalibrationSample[], keys: FeatureKey[], lambda: number): Required<Mapping> {
  const raw = fit.map((s) => keys.map((k) => s.features[k]));
  const k = keys.length;
  const mean = Array.from({ length: k }, (_, j) => raw.reduce((s, r) => s + r[j], 0) / raw.length);
  const std = Array.from({ length: k }, (_, j) => {
    const sd = Math.sqrt(raw.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / raw.length);
    return sd > 1e-6 ? sd : 1;
  });
  const X = raw.map((r) => standardise(r, mean, std));
  return {
    featureKeys: keys,
    mean,
    std,
    wx: ridgeFit(X, fit.map((s) => s.target.x), lambda),
    wy: ridgeFit(X, fit.map((s) => s.target.y), lambda),
  };
}

const sampleError = (m: Mapping, s: CalibrationSample) => {
  const q = predictScreen(m, s.features);
  return Math.hypot(q.x - s.target.x, q.y - s.target.y);
};

/** Fit RMS over training samples; used for lag selection, so it never looks at held-out data. */
export function fitRms(samples: CalibrationSample[], keys: FeatureKey[], lambda = 0.5): number {
  const fit = samples.filter((s) => !s.holdout);
  const m = fitMapping(fit, keys, lambda);
  return rms(fit.map((s) => sampleError(m, s)));
}

export function fitCalibration(samples: CalibrationSample[], opts: FitOptions): CalibrationModel {
  const keys = opts.featureKeys ?? DOT_FEATURES;
  const fit = samples.filter((s) => !s.holdout);
  const held = samples.filter((s) => s.holdout);
  // At least a few more samples than parameters (features + bias); 9 dots with 4 features passes.
  const minFit = Math.max(6, keys.length + 3);
  if (fit.length < minFit) throw new Error(`need at least ${minFit} fitting samples, got ${fit.length}`);
  if (held.length < 1) throw new Error("need at least 1 held-out sample");

  const lambda = opts.lambda ?? 0.5;
  const mapping = fitMapping(fit, keys, lambda);
  const fitRmsPx = rms(fit.map((s) => sampleError(mapping, s)));

  const byGroup = new Map<string, number[]>();
  for (const s of held) {
    const errs = byGroup.get(s.group) ?? [];
    errs.push(sampleError(mapping, s));
    byGroup.set(s.group, errs);
  }
  const heldoutErrorsPx = [...byGroup.values()].map((e) => e.reduce((a, b) => a + b, 0) / e.length);
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
    method: opts.method ?? "dots",
    ...mapping,
    lagMs: opts.lagMs ?? 0,
    fitSamples: fit.length,
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

// ---------------------------------------------------------------------------
// Moving-dot (smooth pursuit) calibration
// ---------------------------------------------------------------------------

export interface PursuitConfig {
  durationMs: number;
  /** Ignore the start while the eyes catch up with the dot. */
  warmupMs: number;
  /** Time blocks; every `holdoutEvery`-th block is held out (blocked split, not random frames). */
  blockMs: number;
  holdoutEvery: number;
  /** Candidate eye-lag values searched on training blocks only. */
  lagCandidatesMs: number[];
  /** Lissajous amplitude as a fraction of the video rect (0.5 = edge to edge). */
  amplitude: number;
  periodXMs: number;
  periodYMs: number;
}

export const DEFAULT_PURSUIT: PursuitConfig = {
  durationMs: 24_000,
  warmupMs: 1_200,
  blockMs: 2_000,
  holdoutEvery: 4,
  lagCandidatesMs: [0, 50, 100, 150, 200, 250, 300],
  amplitude: 0.42,
  // Peak speed ~ 2π·A·W / P: for a 900 px wide video about 340 px/s, slow enough for smooth pursuit.
  periodXMs: 7_000,
  periodYMs: 5_000,
};

/** Dot position (u, v fractions of the video) at time t; starts at the centre. */
export function pursuitPath(tMs: number, cfg: PursuitConfig = DEFAULT_PURSUIT): { u: number; v: number } {
  return {
    u: 0.5 + cfg.amplitude * Math.sin((2 * Math.PI * tMs) / cfg.periodXMs),
    v: 0.5 + cfg.amplitude * Math.sin((2 * Math.PI * tMs) / cfg.periodYMs),
  };
}

export interface TimedFeatures {
  /** Milliseconds since the moving dot started. */
  tMs: number;
  features: FrameFeatures;
}

/**
 * Turn timed frames into calibration samples, assuming the eyes trail the dot by `lagMs`.
 * Held-out membership depends only on time blocks, never on the lag, so lag search can't leak.
 */
export function pursuitSamples(
  frames: TimedFeatures[],
  rect: ScreenRect,
  lagMs: number,
  cfg: PursuitConfig = DEFAULT_PURSUIT,
): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (const fr of frames) {
    if (fr.tMs < cfg.warmupMs || fr.tMs > cfg.durationMs) continue;
    const { u, v } = pursuitPath(fr.tMs - lagMs, cfg);
    const block = Math.floor(fr.tMs / cfg.blockMs);
    out.push({
      target: { x: rect.left + u * rect.width, y: rect.top + v * rect.height },
      features: fr.features,
      group: `block-${block}`,
      holdout: block % cfg.holdoutEvery === cfg.holdoutEvery - 1,
    });
  }
  return out;
}

/** Pick the eye lag that best fits the training blocks, then fit and evaluate on held-out blocks. */
export function fitPursuitCalibration(
  frames: TimedFeatures[],
  rect: ScreenRect,
  cfg: PursuitConfig = DEFAULT_PURSUIT,
  opts: Partial<FitOptions> = {},
): CalibrationModel {
  const keys = opts.featureKeys ?? PURSUIT_FEATURES;
  let best = { lag: 0, err: Infinity };
  for (const lag of cfg.lagCandidatesMs) {
    const err = fitRms(pursuitSamples(frames, rect, lag, cfg), keys, opts.lambda);
    if (err < best.err) best = { lag, err };
  }
  return fitCalibration(pursuitSamples(frames, rect, best.lag, cfg), {
    ...opts,
    videoRect: rect,
    featureKeys: keys,
    method: "pursuit",
    lagMs: best.lag,
  });
}

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
