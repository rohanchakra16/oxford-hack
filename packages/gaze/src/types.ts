/**
 * Gaze module message types (draft contract v0, proposed to Person 5).
 *
 * Conventions:
 * - `*_ms` fields on the browser monotonic clock are `performance.now()` values.
 * - Screen coordinates are CSS pixels relative to the top-left of the screen.
 * - Video coordinates (`video_u`, `video_v`) are fractions of the lecture video's
 *   on-screen rectangle (0..1 inside the video; outside that range = off the video).
 * - Missing measurements are `null` with a reason code, never 0.
 */

export const GAZE_OBSERVATION_SCHEMA = "gaze_observation/v0" as const;
export const GAZE_SUMMARY_SCHEMA = "gaze_summary/v0" as const;

/** Why an observation is unavailable or degraded. Findings (e.g. looking away) are NOT reasons. */
export type GazeReasonCode =
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_NOT_FOUND"
  | "CAMERA_IN_USE"
  | "CAMERA_DISCONNECTED"
  | "MODEL_NOT_READY"
  | "TAB_HIDDEN"
  | "FACE_NOT_DETECTED"
  | "MULTIPLE_FACES"
  | "CALIBRATION_NONE"
  | "CALIBRATION_STALE"
  | "CALIBRATION_TOO_COARSE"
  | "VIDEO_NOT_VISIBLE";

/**
 * Where gaze appears to be relative to the lecture video.
 * `uncertain` means the estimate falls within the calibration error margin of the edge.
 */
export type GazeRegion = "on_video" | "off_video" | "uncertain";

export type CalibrationStatus = "none" | "valid" | "stale" | "too_coarse";

/** Calibration quality tier, decided from held-out error relative to the video size. */
export type CalibrationQuality = "fine" | "coarse" | "unusable";

export interface GazeObservation {
  schema: typeof GAZE_OBSERVATION_SCHEMA;
  session_id: string;
  frame_seq: number;
  /** Frame capture time on the browser monotonic clock (performance.now()). */
  observed_at_ms: number;
  /** Wall-clock time for logs only; do not use for synchronisation. */
  wall_clock_ms: number;
  /** "valid" means a face was measured; gaze fields may still be null (see reasons). */
  status: "valid" | "unavailable";
  reasons: GazeReasonCode[];
  face: {
    detected: boolean;
    head_yaw_deg: number | null;
    head_pitch_deg: number | null;
    head_roll_deg: number | null;
    /** Iris position within the eye opening, approx -0.5..0.5; +x = image right, +y = down. */
    iris_x: number | null;
    iris_y: number | null;
    /** 0 = closed, 1 = fully open. Derived from blink blendshapes. */
    eye_openness: number | null;
    eyes_closed: boolean | null;
    /**
     * How far the face centre has moved in the camera image since calibration (fraction of the image).
     * Null without a calibration. Large values mean the screen mapping is likely off.
     */
    pose_shift: number | null;
    /** Face size relative to calibration (>1 = closer to the camera). Null without a calibration. */
    scale_ratio: number | null;
  };
  gaze: {
    /** Smoothed (rolling median) screen estimate; `region` is decided from this point. */
    screen_x_px: number | null;
    screen_y_px: number | null;
    video_u: number | null;
    video_v: number | null;
    region: GazeRegion | null;
    /** Distance from the video edge that counts as "uncertain" (from held-out calibration error). */
    margin_px: number | null;
  };
  calibration: {
    id: string | null;
    status: CalibrationStatus;
    quality: CalibrationQuality | null;
    heldout_rms_px: number | null;
  };
  model: { name: string; version: string };
}

export interface GazeSummary {
  schema: typeof GAZE_SUMMARY_SCHEMA;
  session_id: string;
  window_start_ms: number;
  window_end_ms: number;
  frames_processed: number;
  /** Fraction of the window's observations that had a usable region estimate. */
  valid_coverage: number;
  /** Fractions below are relative to observations with a region (sum to 1), or null if none. */
  on_video_fraction: number | null;
  off_video_fraction: number | null;
  uncertain_fraction: number | null;
  /** Longest continuous off-video run within the window, in ms. */
  longest_off_video_ms: number;
  face_missing_fraction: number;
  eyes_closed_fraction: number | null;
  /** Most frequent unavailability reasons in this window. */
  top_reasons: GazeReasonCode[];
}

/** Per-frame features extracted from the face model, before calibration. */
export interface FrameFeatures {
  headYawDeg: number;
  headPitchDeg: number;
  headRollDeg: number;
  irisX: number;
  irisY: number;
  eyeOpenness: number;
  /** Face centre in normalised camera-image coordinates (0..1). */
  faceCenterX: number;
  faceCenterY: number;
  /**
   * Proxy for closeness to the camera (bigger = closer). From the face model's 3D depth when available
   * (unaffected by head turns); otherwise the outer-eye-corner distance divided by image width.
   */
  faceScale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
