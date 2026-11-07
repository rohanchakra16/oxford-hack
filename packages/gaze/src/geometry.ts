import type { ScreenPoint, ScreenRect } from "./types";

/**
 * Converts between viewport (CSS px inside the page) and screen coordinates.
 *
 * Calibration is stored in screen space, so moving, resizing or scrolling the window,
 * or resizing the video, does not invalidate it; only the head/camera pose does.
 * The browser toolbar height is approximated as outerHeight - innerHeight
 * (0 in fullscreen). This is approximate: it ignores side borders and devtools docked at the bottom.
 */
export function viewportOrigin(win: Window = window): ScreenPoint {
  const chrome = Math.max(0, win.outerHeight - win.innerHeight);
  return { x: win.screenX, y: win.screenY + chrome };
}

export function viewportToScreen(p: ScreenPoint, win: Window = window): ScreenPoint {
  const o = viewportOrigin(win);
  return { x: p.x + o.x, y: p.y + o.y };
}

export function screenToViewport(p: ScreenPoint, win: Window = window): ScreenPoint {
  const o = viewportOrigin(win);
  return { x: p.x - o.x, y: p.y - o.y };
}

/** On-screen rectangle of an element, or null if it is not visible. */
export function elementScreenRect(el: Element | null, win: Window = window): ScreenRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  // Clip to the viewport: a video scrolled half out of view only occupies its visible part.
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(win.innerWidth, r.right);
  const bottom = Math.min(win.innerHeight, r.bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  const o = viewportOrigin(win);
  return { left: left + o.x, top: top + o.y, width: right - left, height: bottom - top };
}

/** Screen point of a target given as fractions (u, v) of a rect. */
export function pointInRect(rect: ScreenRect, u: number, v: number): ScreenPoint {
  return { x: rect.left + u * rect.width, y: rect.top + v * rect.height };
}
