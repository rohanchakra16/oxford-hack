import { describe, expect, it, vi } from "vitest";
import {
  gazeProvenance,
  ObservationBatcher,
  toContractCalibration,
  toContractId,
  toContractObservation,
  type ContractGazeObservation,
} from "./contract";
import type { CalibrationModel } from "./calibration";
import type { CalibrationStateEvent } from "./engine";
import type { GazeObservation, GazeReasonCode, GazeRegion } from "./types";

function obs(over: {
  region?: GazeRegion | null;
  u?: number | null;
  v?: number | null;
  reasons?: GazeReasonCode[];
  eyesClosed?: boolean | null;
  calId?: string | null;
}): GazeObservation {
  return {
    schema: "gaze_observation/v0",
    session_id: "harness-2026-11-07T15-00-00-000Z",
    frame_seq: 42,
    observed_at_ms: 3500,
    processed_at_ms: 3512,
    wall_clock_ms: 0,
    status: "valid",
    reasons: over.reasons ?? [],
    face: {
      detected: true,
      head_yaw_deg: 1,
      head_pitch_deg: 2,
      head_roll_deg: 0,
      iris_x: 0,
      iris_y: 0,
      eye_openness: 0.9,
      eyes_closed: over.eyesClosed ?? false,
      pose_shift: 0.01,
      scale_ratio: 1,
    },
    gaze: {
      screen_x_px: 100,
      screen_y_px: 100,
      video_u: over.u === undefined ? 0.5 : over.u,
      video_v: over.v === undefined ? 0.5 : over.v,
      region: over.region === undefined ? "on_video" : over.region,
      margin_x_px: 50,
      margin_y_px: 120,
    },
    calibration: {
      id: over.calId === undefined ? "cal-abc" : over.calId,
      status: "valid",
      quality: "coarse",
      heldout_rms_px: 100,
      heldout_rms_x_px: 40,
      heldout_rms_y_px: 90,
    },
    model: { name: "m", version: "v" },
  };
}

/** The contract's semantic rules (platform/src/oxford_hack/contracts/payloads.py GazeObservation). */
function assertContractRules(c: ContractGazeObservation) {
  expect(c.observationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
  expect(c.observationId.length).toBeLessThanOrEqual(128);
  expect(c.tBrowserProcessedMs).toBeGreaterThanOrEqual(c.tBrowserFrameMs);
  if (c.valid) {
    expect(c.invalidReasons).toEqual([]);
    expect(c.videoPoint).not.toBeNull();
    expect(c.insideVideo).not.toBeNull();
  } else {
    expect(c.invalidReasons.length).toBeGreaterThan(0);
    expect(c.videoPoint).toBeNull();
    expect(c.insideVideo).toBeNull();
  }
  // Exactly the contract's fields (extra="forbid").
  expect(Object.keys(c).sort()).toEqual(
    [
      "observationId",
      "tBrowserFrameMs",
      "tBrowserProcessedMs",
      "measurementKind",
      "calibrationId",
      "valid",
      "invalidReasons",
      "videoPoint",
      "insideVideo",
      "modelConfidence",
    ].sort(),
  );
}

describe("toContractObservation", () => {
  it("maps on/off video to valid observations with a normalised point", () => {
    const on = toContractObservation(obs({ region: "on_video", u: 0.4, v: 0.6 }));
    assertContractRules(on);
    expect(on).toMatchObject({ valid: true, insideVideo: true, videoPoint: { x: 0.4, y: 0.6 }, calibrationId: "cal-abc" });

    const off = toContractObservation(obs({ region: "off_video", u: 1.3, v: 0.4 }));
    assertContractRules(off);
    expect(off).toMatchObject({ valid: true, insideVideo: false, videoPoint: { x: 1.3, y: 0.4 } });
  });

  it("clamps far-off estimates to the contract's [-10, 10] range", () => {
    const c = toContractObservation(obs({ region: "off_video", u: -14.2, v: 30 }));
    expect(c.videoPoint).toEqual({ x: -10, y: 10 });
  });

  it("maps 'uncertain' to invalid low_confidence rather than guessing insideVideo", () => {
    const c = toContractObservation(obs({ region: "uncertain", u: 0.98, v: 0.5 }));
    assertContractRules(c);
    expect(c.invalidReasons).toEqual(["low_confidence"]);
  });

  it("maps internal reasons to contract reasons without duplicates", () => {
    const c = toContractObservation(
      obs({ region: null, u: null, v: null, reasons: ["CAMERA_DISCONNECTED", "CALIBRATION_NONE", "CAMERA_IN_USE"], calId: null }),
    );
    assertContractRules(c);
    expect(c.invalidReasons.sort()).toEqual(["calibration_missing", "camera_unavailable"]);
    expect(c.calibrationId).toBeNull();
  });

  it("reports closed eyes as eyes_not_detected", () => {
    const c = toContractObservation(obs({ region: null, u: null, v: null, eyesClosed: true }));
    assertContractRules(c);
    expect(c.invalidReasons).toEqual(["eyes_not_detected"]);
  });

  it("makes contract-safe ids", () => {
    expect(toContractId("gz-harness 2026/11/07T15:00")).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
    expect(toContractId("--x")).toBe("x");
    expect(toContractId("a".repeat(300)).length).toBe(128);
  });
});

describe("toContractCalibration", () => {
  const geometry = {
    viewportCssPx: { x: 0, y: 0, width: 1280, height: 800 },
    videoRectCssPx: { x: 16, y: 64, width: 892, height: 502 },
  };
  const attempt = { id: "cal-xyz", method: "15-dot fit (11 fit, 4 held out), ridge", geometry };
  const model = { fitSamples: 11, heldoutErrorsPx: [80, 100, 120, 100] } as unknown as CalibrationModel;
  const prov = gazeProvenance("live", "gaze-0.1.0");

  it("reports a valid calibration with held-out error as a fraction of video width", () => {
    const e: CalibrationStateEvent = { status: "valid", attempt, model, reason: null, tBrowserMs: 2000 };
    const c = toContractCalibration(e, prov);
    expect(c).toMatchObject({
      calibrationId: "cal-xyz",
      status: "valid",
      measurementKind: "screen_gaze",
      fitPoints: 11,
      heldOutPoints: 4,
      videoRectCssPx: geometry.videoRectCssPx,
      invalidatedReason: null,
      provenance: { runKind: "live", producer: "gaze-webcam-mediapipe", producerVersion: "gaze-0.1.0" },
    });
    expect(c.heldOutErrorNorm).toBeCloseTo(100 / 892, 6);
  });

  it("reports in-progress and expired states", () => {
    const p = toContractCalibration({ status: "in_progress", attempt, model: null, reason: null, tBrowserMs: 1 }, prov);
    expect(p).toMatchObject({ status: "in_progress", fitPoints: 0, heldOutPoints: 0, heldOutErrorNorm: null });
    const x = toContractCalibration({ status: "expired", attempt, model, reason: "head moved", tBrowserMs: 9 }, prov);
    expect(x).toMatchObject({ status: "expired", invalidatedReason: "head moved" });
  });
});

describe("ObservationBatcher", () => {
  const c = toContractObservation(obs({}));

  it("flushes on a timer and caps batch size at 64", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const b = new ObservationBatcher((batch) => sent.push(batch.length), { flushMs: 150 });
    for (let i = 0; i < 3; i++) b.push(c);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([3]);
    for (let i = 0; i < 70; i++) b.push(c);
    expect(sent).toEqual([3, 64]);
    b.dispose();
    expect(sent).toEqual([3, 64, 6]);
    vi.useRealTimers();
  });

  it("drops a batch if sending throws instead of queueing stale data", () => {
    const b = new ObservationBatcher(() => {
      throw new Error("socket closed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    b.push(c);
    expect(() => b.flush()).not.toThrow();
    warn.mockRestore();
  });
});
