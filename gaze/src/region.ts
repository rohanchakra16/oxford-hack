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

export function videoUV(p: ScreenPoint, r: ScreenRect): { u: number; v: number } {
  return { u: (p.x - r.left) / r.width, v: (p.y - r.top) / r.height };
}
