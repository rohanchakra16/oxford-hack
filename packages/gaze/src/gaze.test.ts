import { describe, expect, it } from "vitest";
import { fitCalibration, predictScreen, StalenessTracker, type CalibrationPoint } from "./calibration";
import { extractFeatures, headPoseFromMatrix, medianFeatures, type Landmark } from "./features";
import { classifyRegion, signedDistanceToRect } from "./region";
import { summarise } from "./summary";
import type { FrameFeatures, GazeObservation, ScreenRect } from "./types";

const DEG = Math.PI / 180;

/** Column-major 4x4 for R = Ry(yaw) Rx(pitch) Rz(roll) with translation t. */
function transform(yawDeg: number, pitchDeg: number, rollDeg: number, columnMajor = true): number[] {
  const [y, p, r] = [yawDeg * DEG, pitchDeg * DEG, rollDeg * DEG];
  const Ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const Rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]];
  const Rz = [[Math.cos(r), -Math.sin(r), 0], [Math.sin(r), Math.cos(r), 0], [0, 0, 1]];
  const mul = (A: number[][], B: number[][]) => A.map((row) => B[0].map((_, j) => row.reduce((s, a, k) => s + a * B[k][j], 0)));
  const R = mul(mul(Ry, Rx), Rz);
  const t = [1.5, -2, -45];
  const M = [
    [...R[0], t[0]],
    [...R[1], t[1]],
    [...R[2], t[2]],
    [0, 0, 0, 1],
  ];
  const out: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out.push(columnMajor ? M[j][i] : M[i][j]);
  return out;
}

describe("headPoseFromMatrix", () => {
  it.each([true, false])("recovers yaw/pitch/roll (columnMajor=%s)", (cm) => {
    const pose = headPoseFromMatrix(transform(20, -10, 5, cm));
    expect(pose.yaw).toBeCloseTo(20, 5);
    expect(pose.pitch).toBeCloseTo(-10, 5);
    expect(pose.roll).toBeCloseTo(5, 5);
  });
});

/** Synthetic 478-point face with eyes at known positions and irises offset by (dx, dy) of eye width/height. */
function syntheticFace(dx: number, dy: number, swapIrisOrder = false): Landmark[] {
  const pts: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eye = (outer: number, inner: number, top: number, bottom: number, x0: number, x1: number) => {
    pts[outer] = { x: x0, y: 0.4 };
    pts[inner] = { x: x1, y: 0.4 };
    const mx = (x0 + x1) / 2;
    pts[top] = { x: mx, y: 0.38 };
    pts[bottom] = { x: mx, y: 0.42 };
    return { mx, w: Math.abs(x1 - x0) };
  };
  const a = eye(33, 133, 159, 145, 0.35, 0.45); // image-left eye
  const b = eye(263, 362, 386, 374, 0.65, 0.55); // image-right eye
  const irisA = { x: a.mx + dx * a.w, y: 0.4 + dy * 0.04 };
  const irisB = { x: b.mx + dx * b.w, y: 0.4 + dy * 0.04 };
  pts[468] = swapIrisOrder ? irisB : irisA;
  pts[473] = swapIrisOrder ? irisA : irisB;
  return pts;
}

describe("extractFeatures", () => {
  it("measures iris offset in image direction for both eyes", () => {
    const f = extractFeatures(syntheticFace(0.2, -0.25), null, null, 1)!;
    expect(f.irisX).toBeCloseTo(0.2, 5);
    expect(f.irisY).toBeCloseTo(-0.25, 5);
  });

  it("pairs irises with the nearer eye regardless of index order", () => {
    const f = extractFeatures(syntheticFace(0.1, 0, true), null, null, 1)!;
    expect(f.irisX).toBeCloseTo(0.1, 5);
  });

  it("uses blink blendshapes for eye openness", () => {
    const f = extractFeatures(syntheticFace(0, 0), null, [
      { categoryName: "eyeBlinkLeft", score: 0.9 },
      { categoryName: "eyeBlinkRight", score: 0.7 },
    ], 1)!;
    expect(f.eyeOpenness).toBeCloseTo(0.2, 5);
  });

  it("rejects landmark sets without refined irises", () => {
    expect(extractFeatures(syntheticFace(0, 0).slice(0, 468), null, null, 1)).toBeNull();
  });
});

const baseFeatures: FrameFeatures = {
  headYawDeg: 0,
  headPitchDeg: 0,
  headRollDeg: 0,
  irisX: 0,
  irisY: 0,
  eyeOpenness: 1,
  faceCenterX: 0.5,
  faceCenterY: 0.5,
  faceScale: 0.2,
};

describe("fitCalibration", () => {
  const rect: ScreenRect = { left: 100, top: 100, width: 800, height: 450 };
  // Ground-truth mapping: screen point is linear in yaw/pitch/iris.
  const truth = (f: FrameFeatures) => ({
    x: 500 + 20 * f.headYawDeg + 600 * f.irisX,
    y: 325 - 15 * f.headPitchDeg + 400 * f.irisY,
  });
  const makePoints = (noise: number): CalibrationPoint[] => {
    const grid = [
      // Head and iris vary independently so the four features are not collinear.
      [-8, -6, 0.05, 0.1], [0, -6, -0.1, 0], [8, -6, 0, -0.1],
      [-8, 0, 0.1, -0.05], [0, 0, 0, 0.05], [8, 0, -0.05, 0.1],
      [-8, 6, -0.1, 0], [0, 6, 0.1, -0.1], [8, 6, 0.05, 0.05],
      [-4, 3, 0.05, -0.05], [4, -3, -0.05, 0.05],
    ];
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    return grid.map(([yaw, pitch, ix, iy], i) => {
      const features = { ...baseFeatures, headYawDeg: yaw, headPitchDeg: pitch, irisX: ix, irisY: iy };
      const t = truth(features);
      return { features, target: { x: t.x + noise * rnd(), y: t.y + noise * rnd() }, holdout: i >= 9 };
    });
  };

  it("recovers a linear mapping and rates it fine", () => {
    const m = fitCalibration(makePoints(0), { videoRect: rect, lambda: 1e-6 });
    const f = { ...baseFeatures, headYawDeg: 3, headPitchDeg: -2, irisX: 0.02, irisY: 0.04 };
    const p = predictScreen(m, f);
    expect(p.x).toBeCloseTo(truth(f).x, 1);
    expect(p.y).toBeCloseTo(truth(f).y, 1);
    expect(m.heldoutRmsPx).toBeLessThan(1);
    expect(m.quality).toBe("fine");
    expect(m.marginPx).toBe(40); // floor
  });

  it("reports held-out error honestly and downgrades quality for noisy calibration", () => {
    const m = fitCalibration(makePoints(400), { videoRect: rect });
    expect(m.heldoutRmsPx).toBeGreaterThan(90);
    expect(m.quality).not.toBe("fine");
    expect(m.marginPx).toBeCloseTo(1.5 * m.heldoutRmsPx, 5);
  });

  it("refuses to fit without enough points or a held-out set", () => {
    const pts = makePoints(0);
    expect(() => fitCalibration(pts.slice(0, 5), { videoRect: rect })).toThrow();
    expect(() => fitCalibration(pts.filter((p) => !p.holdout), { videoRect: rect })).toThrow();
  });
});

describe("classifyRegion", () => {
  const r: ScreenRect = { left: 0, top: 0, width: 800, height: 450 };
  it("uses an uncertainty band around the edge", () => {
    expect(classifyRegion({ x: 400, y: 225 }, r, 50)).toBe("on_video");
    expect(classifyRegion({ x: 30, y: 225 }, r, 50)).toBe("uncertain");
    expect(classifyRegion({ x: -30, y: 225 }, r, 50)).toBe("uncertain");
    expect(classifyRegion({ x: -80, y: 225 }, r, 50)).toBe("off_video");
  });
  it("never reports on_video when the margin exceeds half the video", () => {
    expect(classifyRegion({ x: 400, y: 225 }, r, 300)).toBe("uncertain");
  });
  it("measures corner distances diagonally", () => {
    expect(signedDistanceToRect({ x: -3, y: -4 }, r)).toBeCloseTo(5);
  });
});

describe("StalenessTracker", () => {
  it("tolerates brief movement, flags sustained movement, and expires", () => {
    const s = new StalenessTracker({ faceCenterX: 0.5, faceCenterY: 0.5, faceScale: 0.2 });
    const moved = { ...baseFeatures, faceCenterX: 0.7 };
    expect(s.update(moved, 0)).toBe("valid");
    expect(s.update(moved, 1000)).toBe("valid");
    expect(s.update(moved, 2000)).toBe("stale");
    expect(s.update(baseFeatures, 2500)).toBe("valid");
    expect(s.update(moved, 3000)).toBe("valid");
    expect(s.update(moved, 13000)).toBe("expired");
    expect(s.update(baseFeatures, 14000)).toBe("expired");
  });
});

describe("medianFeatures", () => {
  it("ignores a blink-like outlier", () => {
    const m = medianFeatures([
      { ...baseFeatures, irisY: 0.01 },
      { ...baseFeatures, irisY: 0.02 },
      { ...baseFeatures, irisY: 0.9 },
    ]);
    expect(m.irisY).toBe(0.02);
  });
});

function obs(t: number, region: GazeObservation["gaze"]["region"], detected = true): GazeObservation {
  return {
    schema: "gaze_observation/v0",
    session_id: "s",
    frame_seq: t,
    observed_at_ms: t,
    wall_clock_ms: t,
    status: detected ? "valid" : "unavailable",
    reasons: detected ? [] : ["FACE_NOT_DETECTED"],
    face: {
      detected,
      head_yaw_deg: null,
      head_pitch_deg: null,
      head_roll_deg: null,
      iris_x: null,
      iris_y: null,
      eye_openness: null,
      eyes_closed: detected ? false : null,
    },
    gaze: { screen_x_px: null, screen_y_px: null, video_u: null, video_v: null, region, margin_px: null },
    calibration: { id: null, status: "valid", quality: "fine", heldout_rms_px: 10 },
    model: { name: "test", version: "0" },
  };
}

describe("summarise", () => {
  it("computes fractions over observations with a region and breaks off-video runs on missing data", () => {
    const o = [
      obs(0, "on_video"),
      obs(100, "off_video"),
      obs(200, "off_video"),
      obs(300, "off_video"),
      obs(400, null, false), // missing face must not extend the off-video run
      obs(500, "off_video"),
      obs(600, "uncertain"),
      obs(1000, "on_video"), // outside window
    ];
    const s = summarise("s", o, 0, 1000);
    expect(s.frames_processed).toBe(7);
    expect(s.valid_coverage).toBeCloseTo(6 / 7);
    expect(s.off_video_fraction).toBeCloseTo(4 / 6);
    expect(s.longest_off_video_ms).toBe(200);
    expect(s.face_missing_fraction).toBeCloseTo(1 / 7);
    expect(s.top_reasons).toEqual(["FACE_NOT_DETECTED"]);
  });

  it("returns nulls rather than zeros when nothing is measurable", () => {
    const s = summarise("s", [obs(10, null, false)], 0, 1000);
    expect(s.on_video_fraction).toBeNull();
    expect(s.valid_coverage).toBe(0);
  });
});
