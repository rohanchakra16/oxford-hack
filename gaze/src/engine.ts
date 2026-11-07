import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  DEFAULT_PURSUIT,
  calibrationSigma,
  calibrationTargets,
  fitCalibration,
  fitPursuitCalibration,
  predictScreen,
  pursuitPath,
  StalenessTracker,
  type CalibrationGeometry,
  type CalibrationModel,
  type CalibrationSample,
  type PursuitConfig,
  type TimedFeatures,
} from "./calibration";
import { Camera, type CameraState } from "./camera";
import { extractFeatures, medianFeatures, type Landmark } from "./features";
import { elementScreenRect, pointInRect, screenToViewport, viewportScreenRect } from "./geometry";
import { classifyByProbability, DEFAULT_THRESHOLDS, videoUV } from "./region";
import { PointSmoother } from "./smoothing";
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
  /** Rolling-median window for the gaze estimate (ms); 0 disables smoothing. */
  smoothingMs?: number;
  /** P(inside video) at or above which a frame is "on_video" (default 0.6). */
  onThreshold?: number;
  /** P(inside video) at or below which a frame is "off_video" (default 0.07, strict to avoid false alarms). */
  offThreshold?: number;
  /** Floor on the per-axis error used for P(inside), px (default 25). */
  minSigmaPx?: number;
  summaryIntervalMs?: number;
}

export interface FrameDebug {
  landmarks: Landmark[] | null;
  features: FrameFeatures | null;
  screenPoint: ScreenPoint | null;
  processingMs: number;
}

export interface CalibrationUI {
  /**
   * Show a target at a viewport position (CSS px).
   * For dots, `progress` is the dot index out of `total`; for the moving dot it is elapsed ms out of total ms.
   * `moving` is true during moving-dot calibration (render without CSS transitions).
   */
  show(target: ScreenPoint, progress: number, total: number, moving?: boolean): void;
  hide(): void;
}

export interface CalibrationAttempt {
  id: string;
  /** Human-readable method label (contract `method`). */
  method: string;
  geometry: CalibrationGeometry;
}

/** Calibration lifecycle, mirroring the shared GazeCalibration contract's status values. */
export interface CalibrationStateEvent {
  status: "in_progress" | "valid" | "invalid" | "expired";
  attempt: CalibrationAttempt;
  /** The fitted model for valid/invalid-after-fit/expired; null while in progress or if fitting failed. */
  model: CalibrationModel | null;
  reason: string | null;
  tBrowserMs: number;
}

type Events = {
  observation: GazeObservation;
  summary: GazeSummary;
  camera: CameraState;
  frame: FrameDebug;
  calibration: CalibrationModel | null;
  calibrationState: CalibrationStateEvent;
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
  /** Frames collected during calibration, stamped with capture time. */
  private collector: { captureMs: number; features: FrameFeatures }[] | null = null;
  private smoother = new PointSmoother(700);
  private lastCalibrationState: CalibrationStateEvent | null = null;
  private listeners: { [K in keyof Events]?: Set<(e: Events[K]) => void> } = {};

  constructor(options: GazeEngineOptions) {
    this.opts = {
      wasmBasePath: "/mediapipe/wasm",
      modelAssetPath: "/models/face_landmarker.task",
      targetFps: 15,
      eyesClosedThreshold: 0.35,
      smoothingMs: 700,
      onThreshold: DEFAULT_THRESHOLDS.onThreshold,
      offThreshold: DEFAULT_THRESHOLDS.offThreshold,
      minSigmaPx: 25,
      summaryIntervalMs: 1000,
      ...options,
    };
    this.smoother = new PointSmoother(this.opts.smoothingMs);
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
    if (this.collector && features && faces === 1 && !eyesClosed) this.collector.push({ captureMs, features });

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
          if (s === "expired") {
            this.calibrationExpired = true;
            this.emitCalibrationState({
              status: "expired",
              attempt: { id: cal.id, method: cal.methodLabel ?? cal.method, geometry: cal.geometry ?? this.cssGeometry() },
              model: cal,
              reason: "head moved away from the calibration position for over 10 s",
            });
          }
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
      p_inside: null,
      sigma_x_px: null,
      sigma_y_px: null,
    };
    // A gaze location while the eyes are closed is meaningless; eyes_closed reports that finding instead.
    const canMap = f && faces === 1 && cal && calStatus === "valid" && !eyesClosed;
    if (canMap) {
      const p = this.smoother.push(capturedMs, predictScreen(cal, f));
      gaze.screen_x_px = p.x;
      gaze.screen_y_px = p.y;
      const sigma = calibrationSigma(cal, this.opts.minSigmaPx);
      gaze.sigma_x_px = Math.round(sigma.x);
      gaze.sigma_y_px = Math.round(sigma.y);
      if (rect) {
        const uv = videoUV(p, rect);
        gaze.video_u = uv.u;
        gaze.video_v = uv.v;
        const d = classifyByProbability(p, rect, sigma, {
          onThreshold: this.opts.onThreshold,
          offThreshold: this.opts.offThreshold,
        });
        gaze.region = d.region;
        gaze.p_inside = Math.round(d.pInside * 1000) / 1000;
      }
    } else if (!eyesClosed) {
      // Don't let estimates from before a gap (face lost, stale) leak into the next ones. A blink keeps the window.
      this.smoother.reset();
    }

    const poseShift =
      f && cal ? Math.hypot(f.faceCenterX - cal.baseline.faceCenterX, f.faceCenterY - cal.baseline.faceCenterY) : null;
    const scaleRatio = f && cal ? f.faceScale / cal.baseline.faceScale : null;

    const r1 = (x: number) => Math.round(x * 10) / 10;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
      schema: GAZE_OBSERVATION_SCHEMA,
      session_id: this.opts.sessionId,
      frame_seq: this.seq++,
      observed_at_ms: capturedMs,
      processed_at_ms: Math.max(capturedMs, performance.now()),
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
        pose_shift: poseShift === null ? null : r3(poseShift),
        scale_ratio: scaleRatio === null ? null : r3(scaleRatio),
      },
      gaze,
      calibration: {
        id: cal?.id ?? null,
        status: calStatus,
        quality: cal?.quality ?? null,
        heldout_rms_px: cal ? Math.round(cal.heldoutRmsPx) : null,
        heldout_rms_x_px: cal?.heldoutRmsXPx !== undefined ? Math.round(cal.heldoutRmsXPx) : null,
        heldout_rms_y_px: cal?.heldoutRmsYPx !== undefined ? Math.round(cal.heldoutRmsYPx) : null,
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
    this.smoother.reset();
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
    const rect = this.calibrationPreflight();
    const sleep = abortableSleep(signal);

    const targets = calibrationTargets(rect, viewportScreenRect());
    const fitCount = targets.filter((t) => !t.holdout).length;
    const attempt = this.beginAttempt(`${targets.length}-dot fit (${fitCount} fit, ${targets.length - fitCount} held out), ridge`);
    const points: CalibrationSample[] = [];
    try {
      for (const [i, t] of targets.entries()) {
        const target = t.point;
        ui.show(screenToViewport(target), i, targets.length, false);
        await sleep(settleMs);
        this.collector = [];
        await sleep(collectMs);
        const samples = this.collector;
        this.collector = null;
        if (samples.length >= minFrames)
          points.push({
            target,
            features: medianFeatures(samples.map((s) => s.features)),
            group: t.id,
            holdout: t.holdout,
          });
      }
    } catch (err) {
      this.failAttempt(attempt, err);
      throw err;
    } finally {
      this.collector = null;
      ui.hide();
    }
    return this.finishAttempt(attempt, () =>
      fitCalibration(points, { videoRect: rect, method: "dots", id: attempt.id }),
    );
  }

  /** CSS-pixel geometry (viewport coordinates) for the shared GazeCalibration contract. */
  private cssGeometry(): CalibrationGeometry {
    const r = this.opts.getVideoElement()?.getBoundingClientRect();
    return {
      viewportCssPx: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      videoRectCssPx: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null,
    };
  }

  private beginAttempt(method: string): CalibrationAttempt {
    const attempt: CalibrationAttempt = {
      id: `cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      method,
      geometry: this.cssGeometry(),
    };
    this.emitCalibrationState({ status: "in_progress", attempt, model: null, reason: null });
    return attempt;
  }

  private failAttempt(attempt: CalibrationAttempt, err: unknown) {
    const reason = (err as Error)?.name === "AbortError" ? "cancelled" : String((err as Error)?.message ?? err);
    this.emitCalibrationState({ status: "invalid", attempt, model: null, reason });
  }

  private finishAttempt(attempt: CalibrationAttempt, fit: () => CalibrationModel): CalibrationModel {
    let model: CalibrationModel;
    try {
      model = fit();
    } catch (err) {
      this.failAttempt(attempt, err);
      throw err;
    }
    model.geometry = attempt.geometry;
    model.methodLabel = attempt.method;
    this.setCalibration(model);
    const usable = model.quality !== "unusable";
    this.emitCalibrationState({
      status: usable ? "valid" : "invalid",
      attempt,
      model,
      reason: usable ? null : "held-out error too large on both axes",
    });
    return model;
  }

  private emitCalibrationState(s: Omit<CalibrationStateEvent, "tBrowserMs">) {
    this.lastCalibrationState = { ...s, tBrowserMs: performance.now() };
    this.emit("calibrationState", this.lastCalibrationState);
  }

  /** Latest calibration state, for UIs that subscribe late. */
  getCalibrationState(): CalibrationStateEvent | null {
    return this.lastCalibrationState;
  }

  /**
   * Moving-dot calibration: the user follows a slowly moving dot for ~24 s, giving hundreds of
   * samples. Every 4th 2-second block is held out (blocked, not random, because neighbouring frames
   * are near-duplicates), and the eye lag behind the dot is chosen using training blocks only.
   */
  async calibratePursuit(
    ui: CalibrationUI,
    opts: { config?: Partial<PursuitConfig>; signal?: AbortSignal } = {},
  ): Promise<CalibrationModel> {
    const cfg: PursuitConfig = { ...DEFAULT_PURSUIT, ...opts.config };
    const rect = this.calibrationPreflight();
    const signal = opts.signal;
    const attempt = this.beginAttempt(`moving dot ${Math.round(cfg.durationMs / 1000)} s, blocked hold-out (experimental)`);

    const frames: TimedFeatures[] = [];
    let startMs = 0;
    try {
      // Show the start position briefly so the first saccade happens before the clock starts.
      ui.show(screenToViewport(pointInRect(rect, 0.5, 0.5)), 0, cfg.durationMs, true);
      await abortableSleep(signal)(800);
      this.collector = [];
      startMs = performance.now();
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (signal?.aborted) return reject(new DOMException("Calibration cancelled", "AbortError"));
          const t = performance.now() - startMs;
          if (t >= cfg.durationMs) return resolve();
          const { u, v } = pursuitPath(t, cfg);
          ui.show(screenToViewport(pointInRect(rect, u, v)), t, cfg.durationMs, true);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      for (const s of this.collector) frames.push({ tMs: s.captureMs - startMs, features: s.features });
    } catch (err) {
      this.failAttempt(attempt, err);
      throw err;
    } finally {
      this.collector = null;
      ui.hide();
    }
    return this.finishAttempt(attempt, () => {
      if (frames.length < 60) {
        throw new Error(`Only ${frames.length} usable frames (face lost or eyes closed too often). Check lighting and try again.`);
      }
      return fitPursuitCalibration(frames, rect, cfg, { id: attempt.id });
    });
  }

  private calibrationPreflight() {
    const rect = elementScreenRect(this.opts.getVideoElement());
    if (!rect) throw new Error("Lecture video is not visible; cannot calibrate.");
    if (this.camera.state.status !== "live" || !this.landmarker) throw new Error("Camera/model not ready.");
    return rect;
  }
}

function abortableSleep(signal?: AbortSignal) {
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Calibration cancelled", "AbortError"));
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Calibration cancelled", "AbortError"));
        },
        { once: true },
      );
    });
}
