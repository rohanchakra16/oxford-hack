import { describe, expect, it } from "vitest";
import {
  DEFAULT_PURSUIT,
  calibrationSigma,
  calibrationTargets,
  fitCalibration,
  fitPursuitCalibration,
  predictScreen,
  pursuitPath,
  pursuitSamples,
  StalenessTracker,
  type CalibrationModel,
  type CalibrationPoint,
  type TimedFeatures,
} from "./calibration";
import { PointSmoother } from "./smoothing";
import { scoreValidation, type PhaseWindow } from "./validation";
import { extractFeatures, headPoseFromMatrix, medianFeatures, type Landmark } from "./features";
import { classifyByProbability, classifyRegion, normalCdf, signedDistanceToRect } from "./region";
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

  it("measures distance from 3D depth, so turning the head doesn't look like leaning back", () => {
    const face = syntheticFace(0, 0);
    const straight = extractFeatures(face, transform(0, 0, 0), null, 1)!;
    const turned = extractFeatures(face, transform(55, 10, 0), null, 1)!;
    expect(turned.faceScale).toBeCloseTo(straight.faceScale, 6);
    expect(straight.faceScale).toBeCloseTo(10 / 45, 6); // tz = -45 in the test transform
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
      return { features, target: { x: t.x + noise * rnd(), y: t.y + noise * rnd() }, group: `dot-${i}`, holdout: i >= 9 };
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
    expect(m.marginXPx).toBeCloseTo(Math.max(40, 1.5 * m.heldoutRmsXPx), 5);
    expect(m.marginYPx).toBeCloseTo(Math.max(40, 1.5 * m.heldoutRmsYPx), 5);
    expect(m.marginPx).toBe(Math.max(m.marginXPx, m.marginYPx));
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
    processed_at_ms: t + 5,
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
      pose_shift: detected ? 0.01 : null,
      scale_ratio: detected ? 1 : null,
    },
    gaze: { screen_x_px: null, screen_y_px: null, video_u: null, video_v: null, region, p_inside: null, sigma_x_px: null, sigma_y_px: null },
    calibration: { id: null, status: "valid", quality: "fine", heldout_rms_px: 10, heldout_rms_x_px: 6, heldout_rms_y_px: 8 },
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

describe("moving-dot calibration", () => {
  const rect: ScreenRect = { left: 100, top: 100, width: 900, height: 506 };

  /**
   * Simulated viewer whose eyes trail the dot by `lagMs`. The gaze point depends on head angle,
   * iris and head translation, so face position matters (the reason pursuit adds those features).
   */
  function simulate(lagMs: number, noisePx = 0): TimedFeatures[] {
    const frames: TimedFeatures[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let t = 0; t <= DEFAULT_PURSUIT.durationMs; t += 66) {
      const { u, v } = pursuitPath(t - lagMs);
      const gx = rect.left + u * rect.width + noisePx * rnd();
      const gy = rect.top + v * rect.height + noisePx * rnd();
      // Head does part of the work, drifts sideways a little; iris covers the rest.
      const headYaw = (gx - 550) / 40 + 2 * Math.sin(t / 3000);
      const headPitch = -(gy - 353) / 50 + 1.5 * Math.cos(t / 4100);
      const faceCenterX = 0.5 + 0.02 * Math.sin(t / 2300);
      const faceCenterY = 0.5 + 0.015 * Math.cos(t / 2900);
      // Inverse of: gx = 550 + 40*yaw + 1500*irisX + 2000*(faceCenterX-0.5)
      const irisX = (gx - 550 - 40 * headYaw - 2000 * (faceCenterX - 0.5)) / 1500;
      const irisY = (gy - 353 + 50 * headPitch - 1800 * (faceCenterY - 0.5)) / 1200;
      frames.push({
        tMs: t,
        features: { ...baseFeatures, headYawDeg: headYaw, headPitchDeg: headPitch, irisX, irisY, faceCenterX, faceCenterY },
      });
    }
    return frames;
  }

  it("keeps the dot inside the video", () => {
    for (let t = 0; t < 30000; t += 37) {
      const { u, v } = pursuitPath(t);
      expect(u).toBeGreaterThanOrEqual(0.05);
      expect(u).toBeLessThanOrEqual(0.95);
      expect(v).toBeGreaterThanOrEqual(0.05);
      expect(v).toBeLessThanOrEqual(0.95);
    }
  });

  it("holds out whole time blocks, not scattered frames", () => {
    const samples = pursuitSamples(simulate(0), rect, 0);
    const groups = new Map<string, boolean>();
    for (const s of samples) {
      if (groups.has(s.group)) expect(groups.get(s.group)).toBe(s.holdout);
      groups.set(s.group, s.holdout);
    }
    const held = [...groups.values()].filter(Boolean).length;
    expect(held).toBeGreaterThanOrEqual(2);
    expect(samples.every((s) => s.features && s.target)).toBe(true);
    expect(samples.some((s) => s.holdout)).toBe(true);
  });

  it("recovers the eye lag and the mapping from training blocks", () => {
    const m = fitPursuitCalibration(simulate(150), rect, DEFAULT_PURSUIT, { lambda: 1e-6 });
    expect(m.method).toBe("pursuit");
    expect(m.lagMs).toBe(150);
    expect(m.heldoutRmsPx).toBeLessThan(5);
    expect(m.quality).toBe("fine");
    expect(m.heldoutErrorsPx.length).toBeGreaterThanOrEqual(2); // one per held-out block
  });

  it("reports realistic error when gaze is noisy", () => {
    const m = fitPursuitCalibration(simulate(150, 200), rect);
    expect(m.heldoutRmsPx).toBeGreaterThan(40);
    expect(Number.isFinite(m.marginPx)).toBe(true);
  });
});

describe("scoreValidation", () => {
  const phase = (id: string, expected: "on_video" | "off_video") => ({ id, instruction: id, expected, durationMs: 10_000 });
  const windows: PhaseWindow[] = [
    { phase: phase("video", "on_video"), startMs: 0, endMs: 10_000 },
    { phase: phase("phone", "off_video"), startMs: 10_000, endMs: 20_000 },
  ];
  const at = (t: number, region: GazeObservation["gaze"]["region"]) => obs(t, region, region !== null);

  it("skips transitions and computes detection, false alarms and balanced accuracy", () => {
    const o: GazeObservation[] = [
      at(1_000, "off_video"), // inside transition: ignored
      ...[3_000, 4_000, 5_000, 6_000].map((t) => at(t, "on_video")),
      at(7_000, "uncertain"),
      at(8_000, "off_video"), // false alarm
      at(11_000, "on_video"), // inside transition: ignored
      ...[13_000, 14_000, 15_000].map((t) => at(t, "off_video")),
      at(16_000, null), // unavailable counts against correctness
    ];
    const r = scoreValidation(windows, o, 2_500);
    const [video, phone] = r.phases;
    expect(video.frames).toBe(6);
    expect(video.correctFraction).toBeCloseTo(4 / 6);
    expect(phone.frames).toBe(4);
    expect(phone.unavailable).toBe(1);
    expect(r.lookAwayDetectionRate).toBeCloseTo(3 / 4);
    expect(r.falseAlarmRate).toBeCloseTo(1 / 6);
    expect(r.onVideoConfirmRate).toBeCloseTo(4 / 6);
    expect(r.balancedAccuracy).toBeCloseTo((3 / 4 + 5 / 6) / 2);
    expect(r.coverage).toBeCloseTo(9 / 10);
    // The unavailable phone frame was a lost face: counted only in the "incl. face lost" metrics.
    expect(phone.faceLost).toBe(1);
    expect(phone.mainUnavailableReason).toBe("FACE_NOT_DETECTED");
    expect(video.mainUnavailableReason).toBeNull();
    expect(r.lookAwayInclFaceLost).toBeCloseTo(4 / 4);
    expect(r.falseAlarmInclFaceLost).toBeCloseTo(1 / 6);
    expect(r.balancedAccuracyInclFaceLost).toBeCloseTo((1 + 5 / 6) / 2);
    expect(video.medianPoseShift).toBeCloseTo(0.01);
  });

  it("reports the median estimated position per phase for drift diagnosis", () => {
    const withUV = (t: number, u: number, v: number) => {
      const o = at(t, "on_video");
      o.gaze.video_u = u;
      o.gaze.video_v = v;
      return o;
    };
    const r = scoreValidation(windows, [withUV(3000, 0.4, 0.9), withUV(4000, 0.5, 1.1), withUV(5000, 0.6, 1.0)], 2500);
    expect(r.phases[0].medianVideoU).toBeCloseTo(0.5);
    expect(r.phases[0].medianVideoV).toBeCloseTo(1.0);
    expect(r.phases[1].medianVideoU).toBeNull();
  });

  it("returns nulls when a phase has no data", () => {
    const r = scoreValidation(windows, []);
    expect(r.lookAwayDetectionRate).toBeNull();
    expect(r.balancedAccuracy).toBeNull();
  });
});

describe("PointSmoother", () => {
  it("suppresses a single-frame spike", () => {
    const s = new PointSmoother(700);
    s.push(0, { x: 100, y: 100 });
    s.push(66, { x: 102, y: 98 });
    s.push(133, { x: 101, y: 101 });
    const out = s.push(200, { x: 900, y: 900 });
    expect(out.x).toBeLessThan(110);
  });

  it("follows a sustained change once it fills most of the window", () => {
    const s = new PointSmoother(700);
    for (let t = 0; t < 700; t += 66) s.push(t, { x: 100, y: 100 });
    let out = { x: 0, y: 0 };
    for (let t = 700; t < 1300; t += 66) out = s.push(t, { x: 900, y: 100 });
    expect(out.x).toBe(900);
  });

  it("restarts after a gap so old estimates don't leak", () => {
    const s = new PointSmoother(700);
    s.push(0, { x: 100, y: 100 });
    s.push(66, { x: 100, y: 100 });
    expect(s.push(1000, { x: 500, y: 500 }).x).toBe(500);
  });

  it("passes points through when disabled", () => {
    expect(new PointSmoother(0).push(0, { x: 7, y: 8 })).toEqual({ x: 7, y: 8 });
  });
});

describe("per-axis margins", () => {
  const rect: ScreenRect = { left: 0, top: 0, width: 900, height: 500 };

  it("lets a precise horizontal axis call 'off to the side' while vertical is rough", () => {
    const m = { x: 50, y: 300 };
    // 80 px right of the video, vertically centred: beyond the 50 px horizontal band.
    expect(classifyRegion({ x: 980, y: 250 }, rect, m)).toBe("off_video");
    // The same point with a single isotropic 300 px margin would be uncertain.
    expect(classifyRegion({ x: 980, y: 250 }, rect, 300)).toBe("uncertain");
    // 80 px below the video is within the rough vertical band.
    expect(classifyRegion({ x: 450, y: 580 }, rect, m)).toBe("uncertain");
  });

  it("reports per-axis held-out error and judges quality per axis", () => {
    const base = { ...baseFeatures };
    // Mapping: x from yaw (exact), y from pitch plus noise on held-out points only.
    const pts: CalibrationPoint[] = [];
    let i = 0;
    for (const yaw of [-8, 0, 8])
      for (const pitch of [-6, 0, 6]) {
        const f = { ...base, headYawDeg: yaw, headPitchDeg: pitch, irisX: 0.01 * ((i * 7) % 5), irisY: 0.01 * ((i * 3) % 4) };
        pts.push({ features: f, target: { x: 450 + 40 * yaw, y: 250 - 30 * pitch }, group: `in-${i++}`, holdout: false });
      }
    const heldF = [
      { ...base, headYawDeg: 4, headPitchDeg: 3 },
      { ...base, headYawDeg: -4, headPitchDeg: -3 },
    ];
    heldF.forEach((f, k) =>
      pts.push({ features: f, target: { x: 450 + 40 * f.headYawDeg, y: 250 - 30 * f.headPitchDeg + (k ? 200 : -200) }, group: `h-${k}`, holdout: true }),
    );
    const m = fitCalibration(pts, { videoRect: rect, lambda: 1e-6 });
    expect(m.heldoutRmsXPx).toBeLessThan(2);
    expect(m.heldoutRmsYPx).toBeCloseTo(200, 0);
    expect(m.marginXPx).toBe(40);
    expect(m.marginYPx).toBeCloseTo(300, 0);
    expect(m.qualityX).toBe("fine");
    expect(m.qualityY).toBe("coarse");
    expect(m.quality).toBe("coarse");
  });
});

describe("calibrationTargets", () => {
  const video: ScreenRect = { left: 16, top: 60, width: 900, height: 506 };

  it("adds held-out and fitted targets beside and below the video when there is room", () => {
    const viewport: ScreenRect = { left: 0, top: 0, width: 1280, height: 800 };
    const t = calibrationTargets(video, viewport);
    const outside = t.filter((x) => x.outside);
    expect(outside.map((x) => x.id).sort()).toEqual(["below-left", "below-mid", "right-low", "right-mid"]);
    expect(t.filter((x) => x.holdout).length).toBe(4); // 2 inside + 2 outside
    for (const x of outside) {
      const inVideo =
        x.point.x >= video.left && x.point.x <= video.left + video.width && x.point.y >= video.top && x.point.y <= video.top + video.height;
      expect(inVideo).toBe(false);
      expect(x.point.x).toBeLessThanOrEqual(viewport.width - 30);
      expect(x.point.y).toBeLessThanOrEqual(viewport.height - 30);
    }
    // Interleaved, not all appended at the end.
    expect(t.findIndex((x) => x.outside)).toBeLessThan(6);
  });

  it("falls back to in-video targets only when there is no room", () => {
    const tight: ScreenRect = { left: 0, top: 0, width: 930, height: 600 };
    expect(calibrationTargets(video, tight).every((x) => !x.outside)).toBe(true);
    expect(calibrationTargets(video, tight).length).toBe(11);
  });
});

describe("probability-based decision", () => {
  const video: ScreenRect = { left: 0, top: 0, width: 900, height: 500 };

  it("computes the normal CDF accurately", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.5)).toBeCloseTo(0.93319, 4);
    expect(normalCdf(-1.5)).toBeCloseTo(0.06681, 4);
    expect(normalCdf(-6)).toBeLessThan(1e-6);
  });

  it("counts a central estimate as on-video even when vertical error is large (the reported failure)", () => {
    // Estimate at u=0.5, v=0.32 with σy=170 px on a 500 px tall video: the old fixed band (1.5σ = 255 px
    // inside every edge) could never say on_video; P(inside) is ~0.8.
    const d = classifyByProbability({ x: 450, y: 160 }, video, { x: 60, y: 170 });
    expect(d.pInside).toBeGreaterThan(0.75);
    expect(d.pInside).toBeLessThan(0.85);
    expect(d.region).toBe("on_video");
    expect(classifyRegion({ x: 450, y: 160 }, video, { x: 90, y: 255 })).toBe("uncertain");
  });

  it("keeps false alarms strict: off-video only when clearly outside", () => {
    const sigma = { x: 60, y: 170 };
    // 1.5σ right of the edge, vertically centred → P ≈ Φ(-1.5) ≈ 0.067 → off (matches the old band).
    expect(classifyByProbability({ x: 990, y: 250 }, video, sigma).region).toBe("off_video");
    // Just past the edge → uncertain, not off.
    expect(classifyByProbability({ x: 920, y: 250 }, video, sigma).region).toBe("uncertain");
    // Phone below the laptop: far below → off.
    expect(classifyByProbability({ x: 450, y: 1500 }, video, sigma).region).toBe("off_video");
  });

  it("is uncertain near the edge from the inside", () => {
    const d = classifyByProbability({ x: 450, y: 20 }, video, { x: 60, y: 170 });
    expect(d.region).toBe("uncertain");
  });

  it("respects custom thresholds", () => {
    const p = { x: 450, y: 160 };
    const sigma = { x: 60, y: 170 };
    expect(classifyByProbability(p, video, sigma, { onThreshold: 0.9, offThreshold: 0.07 }).region).toBe("uncertain");
  });

  it("derives per-axis σ from the calibration with a floor and a legacy fallback", () => {
    const m = { heldoutRmsPx: 100, heldoutRmsXPx: 10, heldoutRmsYPx: 170 } as unknown as CalibrationModel;
    expect(calibrationSigma(m)).toEqual({ x: 25, y: 170 });
    const legacy = { heldoutRmsPx: 100 } as unknown as CalibrationModel;
    expect(calibrationSigma(legacy).x).toBeCloseTo(100 / Math.SQRT2, 6);
  });
});
