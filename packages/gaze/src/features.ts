import type { FrameFeatures } from "./types";

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export interface Blendshape {
  categoryName: string;
  score: number;
}

/** MediaPipe Face Mesh indices (478-point model with refined irises). */
const EYE_A = { cornerA: 33, cornerB: 133, top: 159, bottom: 145 };
const EYE_B = { cornerA: 263, cornerB: 362, top: 386, bottom: 374 };
const IRIS_CENTERS = [468, 473];

const RAD2DEG = 180 / Math.PI;

/**
 * Extract yaw/pitch/roll (degrees) from a 4x4 rigid transform.
 * MediaPipe's matrix layout has varied between versions, so the layout is detected
 * from where the translation sits (the face is ~30-60 cm from the camera, so the
 * translation z component is large).
 */
export function headPoseFromMatrix(data: ArrayLike<number>): {
  yaw: number;
  pitch: number;
  roll: number;
  /** Translation of the face origin; |tz| is the model's depth estimate (camera-relative units). */
  tx: number;
  ty: number;
  tz: number;
} {
  if (data.length !== 16) throw new Error(`expected 16 matrix values, got ${data.length}`);
  const columnMajor = Math.abs(data[14]) >= Math.abs(data[11]);
  const r = (row: number, col: number) => (columnMajor ? data[col * 4 + row] : data[row * 4 + col]);
  // Decomposition R = Ry(yaw) * Rx(pitch) * Rz(roll).
  const pitch = Math.asin(clamp(-r(1, 2), -1, 1));
  const yaw = Math.atan2(r(0, 2), r(2, 2));
  const roll = Math.atan2(r(1, 0), r(1, 1));
  return {
    yaw: yaw * RAD2DEG,
    pitch: pitch * RAD2DEG,
    roll: roll * RAD2DEG,
    tx: r(0, 3),
    ty: r(1, 3),
    tz: r(2, 3),
  };
}

/** Scale so depth-based faceScale has a similar magnitude to the eye-gap version (~0.2-0.3). */
const DEPTH_SCALE_K = 10;

/**
 * Iris position inside one eye opening.
 * x: 0 at the image-left corner, 1 at the image-right corner.
 * y: 0 at the upper lid, 1 at the lower lid.
 */
function irisWithinEye(
  pts: Landmark[],
  eye: typeof EYE_A,
  iris: Landmark,
  aspect: number,
): { x: number; y: number } {
  const p = (l: Landmark) => ({ x: l.x * aspect, y: l.y });
  let left = p(pts[eye.cornerA]);
  let right = p(pts[eye.cornerB]);
  if (left.x > right.x) [left, right] = [right, left];
  const c = p(iris);
  const vx = right.x - left.x;
  const vy = right.y - left.y;
  const len2 = vx * vx + vy * vy || 1e-9;
  const x = ((c.x - left.x) * vx + (c.y - left.y) * vy) / len2;

  const top = p(pts[eye.top]);
  const bottom = p(pts[eye.bottom]);
  const wx = bottom.x - top.x;
  const wy = bottom.y - top.y;
  const h2 = wx * wx + wy * wy || 1e-9;
  const y = ((c.x - top.x) * wx + (c.y - top.y) * wy) / h2;
  return { x, y };
}

function eyeMid(pts: Landmark[], eye: typeof EYE_A): Landmark {
  const a = pts[eye.cornerA];
  const b = pts[eye.cornerB];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist2(a: Landmark, b: Landmark): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/**
 * Compute frame features from one face's landmarks.
 * @param aspect camera image width / height, so x and y distances are comparable.
 */
export function extractFeatures(
  landmarks: Landmark[],
  transform: ArrayLike<number> | null,
  blendshapes: Blendshape[] | null,
  aspect: number,
): FrameFeatures | null {
  if (landmarks.length < 478) return null; // need refined iris landmarks

  // Pair each iris with the nearer eye rather than trusting index order.
  const irisA = landmarks[IRIS_CENTERS[0]];
  const irisB = landmarks[IRIS_CENTERS[1]];
  const midA = eyeMid(landmarks, EYE_A);
  const swap = dist2(irisA, midA) > dist2(irisB, midA);
  const eyeAIris = swap ? irisB : irisA;
  const eyeBIris = swap ? irisA : irisB;
  const ia = irisWithinEye(landmarks, EYE_A, eyeAIris, aspect);
  const ib = irisWithinEye(landmarks, EYE_B, eyeBIris, aspect);

  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  let depth: number | null = null;
  if (transform) {
    const pose = headPoseFromMatrix(transform);
    ({ yaw, pitch, roll } = pose);
    if (Math.abs(pose.tz) > 1e-6) depth = Math.abs(pose.tz);
  }

  let openness: number;
  const blinkL = blendshapes?.find((b) => b.categoryName === "eyeBlinkLeft")?.score;
  const blinkR = blendshapes?.find((b) => b.categoryName === "eyeBlinkRight")?.score;
  if (blinkL !== undefined && blinkR !== undefined) {
    openness = 1 - (blinkL + blinkR) / 2;
  } else {
    // Fallback: lid gap relative to eye width; ~0.3 when open.
    const ratio = (eye: typeof EYE_A) =>
      Math.sqrt(dist2(landmarks[eye.top], landmarks[eye.bottom])) /
      Math.sqrt(dist2(landmarks[eye.cornerA], landmarks[eye.cornerB]) || 1e-9);
    openness = clamp(((ratio(EYE_A) + ratio(EYE_B)) / 2) / 0.3, 0, 1);
  }

  let cx = 0;
  let cy = 0;
  for (const l of landmarks) {
    cx += l.x;
    cy += l.y;
  }
  cx /= landmarks.length;
  cy /= landmarks.length;

  // Distance proxy. The eye gap in the image shrinks when the head turns (≈ cos(yaw)), which made
  // head turns look like leaning back. Prefer the model's 3D depth, which doesn't change with rotation.
  const outerA = landmarks[EYE_A.cornerA];
  const outerB = landmarks[EYE_B.cornerA];
  const eyeGap = Math.hypot((outerA.x - outerB.x) * aspect, outerA.y - outerB.y) / aspect;
  const faceScale = depth !== null ? DEPTH_SCALE_K / depth : eyeGap;

  return {
    headYawDeg: yaw,
    headPitchDeg: pitch,
    headRollDeg: roll,
    irisX: (ia.x + ib.x) / 2 - 0.5,
    irisY: (ia.y + ib.y) / 2 - 0.5,
    eyeOpenness: openness,
    faceCenterX: cx,
    faceCenterY: cy,
    faceScale,
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Element-wise median of feature vectors; robust to blinks and jitter during calibration. */
export function medianFeatures(samples: FrameFeatures[]): FrameFeatures {
  if (samples.length === 0) throw new Error("no samples");
  const keys = Object.keys(samples[0]) as (keyof FrameFeatures)[];
  const out = {} as FrameFeatures;
  for (const k of keys) {
    const vals = samples.map((s) => s[k]).sort((a, b) => a - b);
    const m = vals.length >> 1;
    out[k] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }
  return out;
}
