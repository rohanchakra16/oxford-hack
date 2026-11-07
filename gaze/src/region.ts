import type { GazeRegion, ScreenPoint, ScreenRect } from "./types";

export interface Margins {
  x: number;
  y: number;
}

/**
 * Signed distance from a point to a rect edge: negative inside (depth from nearest edge),
 * positive outside (distance to the rect).
 */
export function signedDistanceToRect(p: ScreenPoint, r: ScreenRect): number {
  const dx = Math.max(r.left - p.x, 0, p.x - (r.left + r.width));
  const dy = Math.max(r.top - p.y, 0, p.y - (r.top + r.height));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  const inside = Math.min(p.x - r.left, r.left + r.width - p.x, p.y - r.top, r.top + r.height - p.y);
  return -inside;
}

/**
 * Three-way decision with an uncertainty band around the video edge. With per-axis margins the
 * band is measured in units of each axis's margin, so a precise horizontal axis can confidently
 * say "off to the side" even when the vertical axis is rough.
 * If a margin exceeds half the video along that axis, nothing can be confidently "on_video",
 * which is the honest result for a coarse calibration.
 */
export function classifyRegion(p: ScreenPoint, r: ScreenRect, margin: number | Margins): GazeRegion {
  const m = typeof margin === "number" ? { x: margin, y: margin } : margin;
  // Rescale so each axis's margin becomes 1 unit, then use the isotropic rule.
  const scaled = signedDistanceToRect(
    { x: p.x / m.x, y: p.y / m.y },
    { left: r.left / m.x, top: r.top / m.y, width: r.width / m.x, height: r.height / m.y },
  );
  if (scaled <= -1) return "on_video";
  if (scaled >= 1) return "off_video";
  return "uncertain";
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf, max error ~1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Probability that the true gaze point lies inside the rect, given the estimate and per-axis
 * error (standard deviation, px), assuming independent Gaussian errors on each axis.
 */
export function probabilityInside(p: { x: number; y: number }, r: ScreenRect, sigma: Margins): number {
  const axis = (v: number, lo: number, hi: number, s: number) => normalCdf((hi - v) / s) - normalCdf((lo - v) / s);
  const px = axis(p.x, r.left, r.left + r.width, sigma.x);
  const py = axis(p.y, r.top, r.top + r.height, sigma.y);
  return Math.min(1, Math.max(0, px * py));
}

export interface DecisionThresholds {
  /** Report on_video when P(inside) is at least this. Missing an "off" costs little, so this is lenient. */
  onThreshold: number;
  /** Report off_video only when P(inside) is at most this. False alarms trigger wrong suggestions, so this is strict. */
  offThreshold: number;
}

/**
 * Defaults. offThreshold 0.07 matches the earlier fixed band (≈1.5σ outside an edge ⇒ P ≈ Φ(-1.5) ≈ 0.067),
 * so false-alarm behaviour is unchanged. onThreshold 0.4 (was 0.6): webcam vertical error is large, and
 * estimates while watching cluster near the top edge, so at 0.6 about 31% of on-video frames came out
 * "uncertain" in the main app and consumers treat those as missing data. 0.4 kept 91% decided with no
 * extra off_video frames; "off" still needs strong evidence.
 */
export const DEFAULT_THRESHOLDS: DecisionThresholds = { onThreshold: 0.4, offThreshold: 0.07 };

/** Probability-based three-way decision with asymmetric thresholds. */
export function classifyByProbability(
  p: { x: number; y: number },
  r: ScreenRect,
  sigma: Margins,
  t: DecisionThresholds = DEFAULT_THRESHOLDS,
): { region: GazeRegion; pInside: number } {
  const pInside = probabilityInside(p, r, sigma);
  const region: GazeRegion = pInside >= t.onThreshold ? "on_video" : pInside <= t.offThreshold ? "off_video" : "uncertain";
  return { region, pInside };
}

export function videoUV(p: ScreenPoint, r: ScreenRect): { u: number; v: number } {
  return { u: (p.x - r.left) / r.width, v: (p.y - r.top) / r.height };
}
