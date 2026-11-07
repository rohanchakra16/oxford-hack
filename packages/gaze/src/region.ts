import type { GazeRegion, ScreenPoint, ScreenRect } from "./types";

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
 * Three-way decision with an uncertainty band of +/- marginPx around the video edge.
 * If the margin is larger than half the video, nothing can be confidently "on_video",
 * which is the honest result for a coarse calibration.
 */
export function classifyRegion(p: ScreenPoint, r: ScreenRect, marginPx: number): GazeRegion {
  const d = signedDistanceToRect(p, r);
  if (d <= -marginPx) return "on_video";
  if (d >= marginPx) return "off_video";
  return "uncertain";
}

export function videoUV(p: ScreenPoint, r: ScreenRect): { u: number; v: number } {
  return { u: (p.x - r.left) / r.width, v: (p.y - r.top) / r.height };
}
