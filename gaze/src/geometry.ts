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
/**
 * Box of an intrinsic-size image fitted with object-fit: contain (or scale-down), centred
 * (default object-position). Letterboxed/pillarboxed bars are excluded.
 */
export function fitContain(box: ScreenRect, intrinsicW: number, intrinsicH: number, scaleDown = false): ScreenRect {
  let scale = Math.min(box.width / intrinsicW, box.height / intrinsicH);
  if (scaleDown) scale = Math.min(scale, 1);
  const width = intrinsicW * scale;
  const height = intrinsicH * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * The displayed video content in viewport CSS px. The shared contract normalises gaze to "the
 * displayed video content rectangle", so for a <video> with object-fit contain (the default) the
 * letterbox bars are excluded. Other elements (or videos before metadata loads) use their box.
 * Assumes centred object-position and no padding/border on the video element.
 */
export function contentClientRect(el: Element | null): ScreenRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const box = { left: r.left, top: r.top, width: r.width, height: r.height };
  const v = el as HTMLVideoElement;
  if (typeof v.videoWidth === "number" && v.videoWidth > 0 && v.videoHeight > 0) {
    const fit = getComputedStyle(v).objectFit || "contain";
    if (fit === "contain" || fit === "scale-down") return fitContain(box, v.videoWidth, v.videoHeight, fit === "scale-down");
  }
  return box;
}

/** Full (unclipped) displayed content rect in screen coordinates; used to normalise video coordinates. */
export function elementContentScreenRect(el: Element | null, win: Window = window): ScreenRect | null {
  const c = contentClientRect(el);
  if (!c) return null;
  const o = viewportOrigin(win);
  return { left: c.left + o.x, top: c.top + o.y, width: c.width, height: c.height };
}

/** Visible part of the displayed content in screen coordinates, or null if none is visible. */
export function elementScreenRect(el: Element | null, win: Window = window): ScreenRect | null {
  const c = contentClientRect(el);
  if (!c) return null;
  // Clip to the viewport: a video scrolled half out of view only occupies its visible part.
  const left = Math.max(0, c.left);
  const top = Math.max(0, c.top);
  const right = Math.min(win.innerWidth, c.left + c.width);
  const bottom = Math.min(win.innerHeight, c.top + c.height);
  if (right - left < 1 || bottom - top < 1) return null;
  const o = viewportOrigin(win);
  return { left: left + o.x, top: top + o.y, width: right - left, height: bottom - top };
}

/** The page's visible area in screen coordinates. */
export function viewportScreenRect(win: Window = window): ScreenRect {
  const o = viewportOrigin(win);
  return { left: o.x, top: o.y, width: win.innerWidth, height: win.innerHeight };
}

/** Screen point of a target given as fractions (u, v) of a rect. */
export function pointInRect(rect: ScreenRect, u: number, v: number): ScreenPoint {
  return { x: rect.left + u * rect.width, y: rect.top + v * rect.height };
}
