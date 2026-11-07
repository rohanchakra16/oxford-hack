/**
 * Adapter from the gaze module's internal messages to the shared contracts owned by
 * @rohanchakra16 (contracts/, schemaVersion 0.2.0): `gaze_observations` and `gaze_calibration`.
 *
 * The internal GazeObservation (src/types.ts) carries more detail (head pose, uncertainty band,
 * diagnostics) for the harness and evaluation. Only what the contract defines leaves this module.
 *
 * The shapes below mirror the contract by hand because the generated TypeScript types live on
 * `infra/shared-foundation` (frontend/src/contracts/generated). Swap these for the generated
 * types once that branch is merged.
 */
import type { CalibrationStateEvent } from "./engine";
import type { GazeObservation, GazeReasonCode } from "./types";

export const CONTRACT_SCHEMA_VERSION = "0.2.0"; // must equal the shared SCHEMA_VERSION; enforced by frontend/src/integration/gazeCompat.test.ts
export const PRODUCER = "gaze-webcam-mediapipe";

export type RunKind = "live" | "replay" | "simulated";

export type ContractGazeInvalidReason =
  | "face_not_detected"
  | "eyes_not_detected"
  | "calibration_missing"
  | "calibration_invalid"
  | "low_confidence"
  | "camera_unavailable"
  | "video_not_visible"
  | "tab_hidden"
  | "frame_dropped";

export interface ContractProvenance {
  runKind: RunKind;
  producer: string;
  producerVersion: string;
}

export interface ContractGazeObservation {
  observationId: string;
  tBrowserFrameMs: number;
  tBrowserProcessedMs: number;
  measurementKind: "screen_gaze" | "head_direction";
  calibrationId: string | null;
  valid: boolean;
  invalidReasons: ContractGazeInvalidReason[];
  /** Normalised to the video rect: (0,0) top-left, (1,1) bottom-right; outside [0,1] = off the video. */
  videoPoint: { x: number; y: number } | null;
  insideVideo: boolean | null;
  modelConfidence: number | null;
}

export interface ContractCssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContractGazeCalibration {
  calibrationId: string;
  status: "in_progress" | "valid" | "invalid" | "expired";
  measurementKind: "screen_gaze" | "head_direction";
  method: string;
  fitPoints: number;
  heldOutPoints: number;
  /** Mean held-out error as a fraction of video width. */
  heldOutErrorNorm: number | null;
  viewportCssPx: ContractCssRect;
  videoRectCssPx: ContractCssRect;
  invalidatedReason: string | null;
  tBrowserMs: number;
  provenance: ContractProvenance;
}

const REASON_MAP: Record<GazeReasonCode, ContractGazeInvalidReason> = {
  CAMERA_PERMISSION_DENIED: "camera_unavailable",
  CAMERA_NOT_FOUND: "camera_unavailable",
  CAMERA_IN_USE: "camera_unavailable",
  CAMERA_DISCONNECTED: "camera_unavailable",
  MODEL_NOT_READY: "camera_unavailable",
  TAB_HIDDEN: "tab_hidden",
  FACE_NOT_DETECTED: "face_not_detected",
  MULTIPLE_FACES: "low_confidence",
  CALIBRATION_NONE: "calibration_missing",
  CALIBRATION_STALE: "calibration_invalid",
  CALIBRATION_TOO_COARSE: "calibration_invalid",
  VIDEO_NOT_VISIBLE: "video_not_visible",
};

/** Contract Id: ^[A-Za-z0-9][A-Za-z0-9_.:-]*$, at most 128 chars. */
export function toContractId(raw: string): string {
  let id = raw.replace(/[^A-Za-z0-9_.:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  if (!id) id = "x";
  return id.slice(0, 128);
}

const clampPoint = (v: number) => Math.min(10, Math.max(-10, v));

/**
 * Map one internal observation to the contract.
 *
 * - `on_video` / `off_video` → valid, with `insideVideo` true/false.
 * - `uncertain` (estimate within the calibration error band of the video edge) → invalid with
 *   `low_confidence`. The contract's `insideVideo` is a yes/no claim, and inside the band we can't
 *   make it honestly.
 * - Eyes closed → invalid with `eyes_not_detected` (a gaze location is meaningless then).
 * - `modelConfidence` (valid only) = probability the reported `insideVideo` is right:
 *   P(inside) for inside, 1 − P(inside) for outside. Based on held-out calibration error, so it is
 *   only as good as that estimate; not comparable with EEG scores.
 */
export function toContractObservation(o: GazeObservation): ContractGazeObservation {
  const base = {
    observationId: toContractId(`gz-${o.session_id}-${o.frame_seq}`),
    tBrowserFrameMs: Math.max(0, o.observed_at_ms),
    tBrowserProcessedMs: Math.max(0, o.processed_at_ms, o.observed_at_ms),
    measurementKind: "screen_gaze" as const,
    calibrationId: o.calibration.id ? toContractId(o.calibration.id) : null,
  };
  const region = o.gaze.region;
  if ((region === "on_video" || region === "off_video") && o.gaze.video_u !== null && o.gaze.video_v !== null) {
    const inside = region === "on_video";
    const p = o.gaze.p_inside;
    return {
      ...base,
      valid: true,
      invalidReasons: [],
      videoPoint: { x: clampPoint(o.gaze.video_u), y: clampPoint(o.gaze.video_v) },
      insideVideo: inside,
      // Probability that the reported insideVideo value is right, from the calibration error model.
      modelConfidence: p === null ? null : Math.min(1, Math.max(0, inside ? p : 1 - p)),
    };
  }
  const reasons = new Set<ContractGazeInvalidReason>(o.reasons.map((r) => REASON_MAP[r]));
  if (o.face.eyes_closed) reasons.add("eyes_not_detected");
  if (region === "uncertain" || reasons.size === 0) reasons.add("low_confidence");
  return { ...base, valid: false, invalidReasons: [...reasons], videoPoint: null, insideVideo: null, modelConfidence: null };
}

export function toContractCalibration(
  e: CalibrationStateEvent,
  provenance: ContractProvenance,
): ContractGazeCalibration {
  const m = e.model;
  const g = e.attempt.geometry;
  // The engine refuses to calibrate without a visible video, so videoRectCssPx is normally set.
  const videoRect = g.videoRectCssPx ?? g.viewportCssPx;
  const heldOut = m?.heldoutErrorsPx ?? [];
  const meanHeldOut = heldOut.length ? heldOut.reduce((a, b) => a + b, 0) / heldOut.length : null;
  return {
    calibrationId: toContractId(e.attempt.id),
    status: e.status,
    measurementKind: "screen_gaze",
    method: e.attempt.method.slice(0, 200) || "calibration",
    fitPoints: m ? Math.round(m.fitSamples ?? 0) : 0,
    heldOutPoints: heldOut.length,
    heldOutErrorNorm: meanHeldOut !== null && videoRect.width > 0 ? meanHeldOut / videoRect.width : null,
    viewportCssPx: { ...g.viewportCssPx },
    videoRectCssPx: { ...videoRect },
    invalidatedReason: e.reason ? e.reason.slice(0, 500) : null,
    tBrowserMs: Math.max(0, e.tBrowserMs),
    provenance,
  };
}

export function gazeProvenance(runKind: RunKind, producerVersion: string): ContractProvenance {
  return { runKind, producer: PRODUCER, producerVersion };
}

/**
 * Groups observations into batches for `client.sendGazeObservations`. The contract allows at most
 * 64 observations per batch and about 10 batches per second; at ~15 fps a 150 ms flush gives ~2-3
 * per batch. Stale data isn't queued: if `send` throws, that batch is dropped, not retried.
 */
export class ObservationBatcher {
  private buf: ContractGazeObservation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (batch: ContractGazeObservation[]) => void,
    private readonly opts: { maxBatch?: number; flushMs?: number } = {},
  ) {}

  push(o: ContractGazeObservation): void {
    this.buf.push(o);
    if (this.buf.length >= (this.opts.maxBatch ?? 64)) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.opts.flushMs ?? 150);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buf.length) return;
    const batch = this.buf.splice(0, this.opts.maxBatch ?? 64);
    try {
      this.send(batch);
    } catch (err) {
      console.warn("gaze batch dropped", err);
    }
    if (this.buf.length) this.flush();
  }

  dispose(): void {
    this.flush();
  }
}
