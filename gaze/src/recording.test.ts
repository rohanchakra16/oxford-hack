import { describe, expect, it } from "vitest";
import type { CalibrationModel } from "./calibration";
import type { CalibrationStateEvent } from "./engine";
import { CAPTURE_FORMAT, GazeCaptureRecorder, type CaptureLine } from "./recording";
import type { GazeObservation } from "./types";
import { DEFAULT_PHASES } from "./validation";

function obs(seq: number, t: number, region: "on_video" | "off_video" | "uncertain" | null): GazeObservation {
  return {
    schema: "gaze_observation/v0",
    session_id: "harness-2026-11-07T18-00-00-000Z",
    frame_seq: seq,
    observed_at_ms: t,
    processed_at_ms: t + 8,
    wall_clock_ms: 0,
    status: region ? "valid" : "unavailable",
    reasons: region ? [] : ["FACE_NOT_DETECTED"],
    face: {
      detected: !!region,
      head_yaw_deg: 0,
      head_pitch_deg: 0,
      head_roll_deg: 0,
      iris_x: 0,
      iris_y: 0,
      eye_openness: 0.9,
      eyes_closed: false,
      pose_shift: 0,
      scale_ratio: 1,
    },
    gaze: {
      screen_x_px: 1,
      screen_y_px: 1,
      video_u: region ? (region === "off_video" ? 1.5 : 0.5) : null,
      video_v: region ? 0.5 : null,
      region,
      p_inside: region === "on_video" ? 0.9 : region === "off_video" ? 0.02 : region ? 0.3 : null,
      sigma_x_px: 50,
      sigma_y_px: 150,
    },
    calibration: { id: "cal-1", status: "valid", quality: "coarse", heldout_rms_px: 100, heldout_rms_x_px: 50, heldout_rms_y_px: 150 },
    model: { name: "m", version: "v" },
  };
}

const geometry = {
  viewportCssPx: { x: 0, y: 0, width: 1280, height: 800 },
  videoRectCssPx: { x: 16, y: 64, width: 892, height: 502 },
};
const calEvent = (status: CalibrationStateEvent["status"], t: number): CalibrationStateEvent => ({
  status,
  attempt: { id: "cal-1", method: "15-dot fit (11 fit, 4 held out), ridge", geometry },
  model: status === "in_progress" ? null : ({ fitSamples: 11, heldoutErrorsPx: [90, 110, 100, 100] } as unknown as CalibrationModel),
  reason: null,
  tBrowserMs: t,
});

function makeCapture() {
  let now = 1000;
  const rec = new GazeCaptureRecorder({ sessionId: "harness 2026/11/07", producerVersion: "gaze-0.1.0", now: () => now, flushMs: 1e9 });
  rec.calibration(calEvent("in_progress", now));
  now = 2000;
  rec.calibration(calEvent("valid", now));
  for (let i = 0; i < 70; i++) {
    now = 3000 + i * 66;
    rec.observation(obs(i, now, i % 10 === 0 ? null : i < 35 ? "on_video" : "off_video"));
  }
  rec.label({ phase: DEFAULT_PHASES[0], startMs: 3000, endMs: 5300 }, 2500);
  now = 9000;
  rec.calibration(calEvent("expired", now));
  return rec;
}

describe("GazeCaptureRecorder", () => {
  it("writes a header then ordered contract envelopes and labels", () => {
    const lines = makeCapture()
      .toJsonl()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const [header, ...rest] = lines as [Record<string, unknown>, ...CaptureLine[]];
    expect(header).toMatchObject({ format: CAPTURE_FORMAT, formatVersion: 1, schemaVersion: "0.1.0", runKind: "live" });
    expect(header.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

    const kinds = rest.map((l) => (l.kind === "message" ? l.message.type : "label"));
    // in_progress, valid, then observations (64 + remainder flushed before the label), label, expired.
    expect(kinds).toEqual([
      "gaze_calibration",
      "gaze_calibration",
      "gaze_observations",
      "gaze_observations",
      "label",
      "gaze_calibration",
    ]);

    const messages = rest.filter((l): l is Extract<CaptureLine, { kind: "message" }> => l.kind === "message");
    expect(messages.map((m) => m.message.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(messages.map((m) => m.message.messageId)).size).toBe(messages.length);
    const batches = messages.filter((m) => m.message.type === "gaze_observations").map((m) => m.message.payload as { observations: unknown[] });
    expect(batches.map((b) => b.observations.length)).toEqual([64, 6]);

    const label = rest.find((l) => l.kind === "label") as Extract<CaptureLine, { kind: "label" }>;
    expect(label).toMatchObject({ phaseId: "video-1", expected: "on_video", startBrowserMs: 3000, scoredFromBrowserMs: 5300, endBrowserMs: 5300 });

    const statuses = messages.filter((m) => m.message.type === "gaze_calibration").map((m) => (m.message.payload as { status: string }).status);
    expect(statuses).toEqual(["in_progress", "valid", "expired"]);
  });

  it("produces observations that follow the contract's validity rules", () => {
    const capture = makeCapture().toJsonl().trim().split("\n").slice(1).map((l) => JSON.parse(l) as CaptureLine);
    for (const l of capture) {
      if (l.kind !== "message" || l.message.type !== "gaze_observations") continue;
      for (const o of l.message.payload.observations) {
        expect(o.tBrowserProcessedMs).toBeGreaterThanOrEqual(o.tBrowserFrameMs);
        if (o.valid) expect(o.invalidReasons).toEqual([]);
        else expect(o.videoPoint).toBeNull();
      }
    }
  });
});
