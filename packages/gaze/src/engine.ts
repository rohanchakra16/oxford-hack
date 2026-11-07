import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  DEFAULT_TARGETS,
  fitCalibration,
  predictScreen,
  StalenessTracker,
  type CalibrationModel,
  type CalibrationPoint,
} from "./calibration";
import { Camera, type CameraState } from "./camera";
import { extractFeatures, medianFeatures, type Landmark } from "./features";
import { elementScreenRect, pointInRect, screenToViewport } from "./geometry";
import { classifyRegion, videoUV } from "./region";
import { summarise } from "./summary";
import {
  GAZE_OBSERVATION_SCHEMA,
  type CalibrationStatus,
  type FrameFeatures,
  type GazeObservation,
  type GazeReasonCode,
  type GazeSummary,
  type ScreenPoint,
} from "./types";

export const MODEL_NAME = "mediapipe-face-landmarker";
export const MODULE_VERSION = "gaze-0.1.0";

export interface GazeEngineOptions {
  sessionId: string;
  /** The lecture video element whose on-screen rect defines "on video". */
  getVideoElement: () => Element | null;
  /** Optional element to show the webcam in (for previews); a detached one is created otherwise. */
  cameraVideo?: HTMLVideoElement;
  wasmBasePath?: string;
  modelAssetPath?: string;
  targetFps?: number;
  /** Eye openness below this counts as closed (0..1). */
  eyesClosedThreshold?: number;
  summaryIntervalMs?: number;
}

export interface FrameDebug {
  landmarks: Landmark[] | null;
  features: FrameFeatures | null;
  screenPoint: ScreenPoint | null;
  processingMs: number;
}

export interface CalibrationUI {
  /** Show a target at a viewport position (CSS px). */
  show(target: ScreenPoint, index: number, total: number): void;
  hide(): void;
}

type Events = {
  observation: GazeObservation;
  summary: GazeSummary;
  camera: CameraState;
  frame: FrameDebug;
  calibration: CalibrationModel | null;
};

export class GazeEngine {
  readonly camera: Camera;
  private landmarker: FaceLandmarker | null = null;
  private opts: Required<Omit<GazeEngineOptions, "cameraVideo">>;
  private running = false;
  private seq = 0;
  private lastDetectTs = 0;
  private lastProcessedMs = -Infinity;
  private lastEmitMs = -Infinity;
  private recent: GazeObservation[] = [];
  private lastSummaryEnd = performance.now();
  private timers: number[] = [];
  private calibration: CalibrationModel | null = null;
  private staleness: StalenessTracker | null = null;
  private calibrationExpired = false;
  private collector: FrameFeatures[] | null = null;
  private listeners: { [K in keyof Events]?: Set<(e: Events[K]) => void> } = {};

  constructor(options: GazeEngineOptions) {
    this.opts = {
      wasmBasePath: "/mediapipe/wasm",
      modelAssetPath: "/models/face_landmarker.task",
      targetFps: 15,
      eyesClosedThreshold: 0.35,
      summaryIntervalMs: 1000,
      ...options,
    };
    this.camera = new Camera(options.cameraVideo);
    this.camera.onChange((s) => this.emit("camera", s));
  }

  on<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void {
    (this.listeners[type] ??= new Set() as never).add(fn as never);
    return () => this.listeners[type]?.delete(fn as never);
  }

  private emit<K extends keyof Events>(type: K, e: Events[K]) {
    this.listeners[type]?.forEach((fn) => (fn as (e: Events[K]) => void)(e));
  }

  async start(): Promise<void> {
    if (this.running) {
      // Allow retrying the camera (e.g. after the user grants permission) without restarting everything.
      if (this.camera.state.status !== "live") await this.camera.start();
      return;
    }
    this.running = true;
    await this.camera.start();
    if (!this.landmarker) this.landmarker = await this.createLandmarker();
    this.timers.push(window.setInterval(() => this.heartbeat(), 1000));
    this.timers.push(window.setInterval(() => this.emitSummary(), this.opts.summaryIntervalMs));
    this.scheduleFrame();
  }

  stop(): void {
    this.running = false;
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.camera.stop();
  }

  private async createLandmarker(): Promise<FaceLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(this.opts.wasmBasePath);
    const make = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.opts.modelAssetPath, delegate },
        runningMode: "VIDEO",
        numFaces: 2, // detect a second face so we can flag ambiguity instead of silently tracking one
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    try {
      return await make("GPU");
    } catch (err) {
      console.warn("GPU delegate failed, falling back to CPU", err);
      return make("CPU");
    }
  }

  private scheduleFrame() {
    if (!this.running) return;
    const v = this.camera.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number }) => void) => number;
    };
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((now, meta) => this.onFrame(meta.captureTime ?? now));
    } else {
      requestAnimationFrame(() => this.onFrame(performance.now()));
    }
  }

  private onFrame(captureMs: number) {
    try {
      const minGap = 1000 / this.opts.targetFps - 2;
      if (
        this.landmarker &&
        this.camera.state.status === "live" &&
        this.camera.video.readyState >= 2 &&
        captureMs - this.lastProcessedMs >= minGap
      ) {
        this.lastProcessedMs = captureMs;
        this.process(captureMs);
      }
    } catch (err) {
      console.error("gaze frame failed", err);
    } finally {
      this.scheduleFrame();
    }
  }

  private process(captureMs: number) {
    const ts = Math.max(this.lastDetectTs + 1, Math.round(performance.now()));
    this.lastDetectTs = ts;
    const t0 = performance.now();
    const result: FaceLandmarkerResult = this.landmarker!.detectForVideo(this.camera.video, ts);
    const processingMs = performance.now() - t0;

    const v = this.camera.video;
    const aspect = v.videoWidth / v.videoHeight || 4 / 3;
    const faces = result.faceLandmarks.length;
    const landmarks = faces ? (result.faceLandmarks[0] as Landmark[]) : null;
    const features = landmarks
      ? extractFeatures(
          landmarks,
          result.facialTransformationMatrixes?.[0]?.data ?? null,
          result.faceBlendshapes?.[0]?.categories ?? null,
          aspect,
        )
      : null;

    const eyesClosed = features ? features.eyeOpenness < this.opts.eyesClosedThreshold : null;
    if (this.collector && features && faces === 1 && !eyesClosed) this.collector.push(features);

    const obs = this.buildObservation(captureMs, faces, features, eyesClosed);
    this.emit("frame", {
      landmarks,
      features,
      screenPoint: obs.gaze.screen_x_px !== null ? { x: obs.gaze.screen_x_px, y: obs.gaze.screen_y_px! } : null,
      processingMs,
    });
    this.push(obs);
  }

  private buildObservation(
    capturedMs: number,
    faces: number,
    f: FrameFeatures | null,
    eyesClosed: boolean | null,
  ): GazeObservation {
    const reasons: GazeReasonCode[] = [];
    if (faces === 0 || !f) reasons.push("FACE_NOT_DETECTED");
    if (faces > 1) reasons.push("MULTIPLE_FACES");

    let calStatus: CalibrationStatus = "none";
    const cal = this.calibration;
    if (!cal) reasons.push("CALIBRATION_NONE");
    else if (cal.quality === "unusable") {
      calStatus = "too_coarse";
      reasons.push("CALIBRATION_TOO_COARSE");
    } else if (this.calibrationExpired) {
      calStatus = "stale";
      reasons.push("CALIBRATION_STALE");
    } else {
      calStatus = "valid";
      if (f && this.staleness) {
        const s = this.staleness.update(f, capturedMs);
        if (s !== "valid") {
          calStatus = "stale";
          reasons.push("CALIBRATION_STALE");
          if (s === "expired") this.calibrationExpired = true;
        }
      }
    }

    const rect = elementScreenRect(this.opts.getVideoElement());
    if (!rect) reasons.push("VIDEO_NOT_VISIBLE");

    const gaze: GazeObservation["gaze"] = {
      screen_x_px: null,
      screen_y_px: null,
      video_u: null,
      video_v: null,
      region: null,
      margin_px: null,
    };
    const canMap = f && faces === 1 && cal && calStatus === "valid";
    if (canMap) {
      const p = predictScreen(cal, f);
      gaze.screen_x_px = p.x;
      gaze.screen_y_px = p.y;
      gaze.margin_px = cal.marginPx;
      // A gaze location while the eyes are closed is meaningless; eyes_closed reports that finding instead.
      if (rect && !eyesClosed) {
        const uv = videoUV(p, rect);
        gaze.video_u = uv.u;
        gaze.video_v = uv.v;
        gaze.region = classifyRegion(p, rect, cal.marginPx);
      }
    }

    const r1 = (x: number) => Math.round(x * 10) / 10;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
      schema: GAZE_OBSERVATION_SCHEMA,
      session_id: this.opts.sessionId,
      frame_seq: this.seq++,
      observed_at_ms: capturedMs,
      wall_clock_ms: Date.now(),
      status: f ? "valid" : "unavailable",
      reasons,
      face: {
        detected: !!f,
        head_yaw_deg: f ? r1(f.headYawDeg) : null,
        head_pitch_deg: f ? r1(f.headPitchDeg) : null,
        head_roll_deg: f ? r1(f.headRollDeg) : null,
        iris_x: f ? r3(f.irisX) : null,
        iris_y: f ? r3(f.irisY) : null,
        eye_openness: f ? r3(f.eyeOpenness) : null,
        eyes_closed: eyesClosed,
      },
      gaze,
      calibration: {
        id: cal?.id ?? null,
        status: calStatus,
        quality: cal?.quality ?? null,
        heldout_rms_px: cal ? Math.round(cal.heldoutRmsPx) : null,
      },
      model: { name: MODEL_NAME, version: MODULE_VERSION },
    };
  }

  /** Emits an explicit "unavailable" observation when no frame was processed recently, so silence never means "fine". */
  private heartbeat() {
    const now = performance.now();
    if (now - this.lastEmitMs < 1000) return;
    const reasons: GazeReasonCode[] = [];
    const cam = this.camera.state;
    if (cam.status === "error") reasons.push(cam.reason);
    else if (document.hidden) reasons.push("TAB_HIDDEN");
    else if (!this.landmarker || cam.status !== "live") reasons.push("MODEL_NOT_READY");
    else reasons.push("FACE_NOT_DETECTED");
    const obs = this.buildObservation(now, 0, null, null);
    obs.reasons = [...reasons, ...obs.reasons.filter((r) => r !== "FACE_NOT_DETECTED")];
    obs.face.detected = false;
    this.push(obs);
  }

  private push(obs: GazeObservation) {
    this.lastEmitMs = performance.now();
    this.recent.push(obs);
    const cutoff = obs.observed_at_ms - 10_000;
    while (this.recent.length && this.recent[0].observed_at_ms < cutoff) this.recent.shift();
    this.emit("observation", obs);
  }

  private emitSummary() {
    const end = performance.now();
    this.emit("summary", summarise(this.opts.sessionId, this.recent, this.lastSummaryEnd, end));
    this.lastSummaryEnd = end;
  }

  getCalibration(): CalibrationModel | null {
    return this.calibration;
  }

  setCalibration(model: CalibrationModel | null): void {
    this.calibration = model;
    this.calibrationExpired = false;
    this.staleness = model ? new StalenessTracker(model.baseline) : null;
    this.emit("calibration", model);
  }

  /**
   * Runs the calibration sequence: the UI shows each target, we wait for the eyes to settle,
   * then take the median features over a collection window. Held-out targets are never fitted.
   */
  async calibrate(
    ui: CalibrationUI,
    opts: { settleMs?: number; collectMs?: number; minFrames?: number; signal?: AbortSignal } = {},
  ): Promise<CalibrationModel> {
    const { settleMs = 800, collectMs = 1000, minFrames = 5, signal } = opts;
    const rect = elementScreenRect(this.opts.getVideoElement());
    if (!rect) throw new Error("Lecture video is not visible; cannot calibrate.");
    if (this.camera.state.status !== "live" || !this.landmarker) throw new Error("Camera/model not ready.");

    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Calibration cancelled", "AbortError"));
        });
      });

    const points: CalibrationPoint[] = [];
    try {
      for (const [i, t] of DEFAULT_TARGETS.entries()) {
        const target = pointInRect(rect, t.u, t.v);
        ui.show(screenToViewport(target), i, DEFAULT_TARGETS.length);
        await sleep(settleMs);
        this.collector = [];
        await sleep(collectMs);
        const samples = this.collector;
        this.collector = null;
        if (samples.length >= minFrames) points.push({ target, features: medianFeatures(samples), holdout: t.holdout });
      }
    } finally {
      this.collector = null;
      ui.hide();
    }
    const model = fitCalibration(points, { videoRect: rect });
    this.setCalibration(model);
    return model;
  }
}
