import type { GazeObservation, GazeReasonCode } from "./types";

/**
 * Look-away accuracy test: the user follows scripted instructions (look at the video, look at a
 * phone, look elsewhere on screen, look away from the screen) and we measure what the module
 * reported in each phase. This tests the decision the product actually depends on, rather than
 * pixel error.
 */

export interface ValidationPhase {
  id: string;
  instruction: string;
  /** What a correct module should report during this phase. */
  expected: "on_video" | "off_video";
  durationMs: number;
}

export const DEFAULT_PHASES: ValidationPhase[] = [
  { id: "video-1", instruction: "Look at the lecture video and watch it normally.", expected: "on_video", durationMs: 15_000 },
  { id: "phone", instruction: "Look down at your phone or the desk below the laptop.", expected: "off_video", durationMs: 12_000 },
  { id: "video-2", instruction: "Look back at the lecture video.", expected: "on_video", durationMs: 12_000 },
  { id: "screen-side", instruction: "Read the text in the side panel (on screen, but not the video).", expected: "off_video", durationMs: 12_000 },
  { id: "video-3", instruction: "Look back at the lecture video.", expected: "on_video", durationMs: 12_000 },
  { id: "away", instruction: "Look away from the screen, e.g. to the side of the room.", expected: "off_video", durationMs: 12_000 },
];

/** Seconds ignored at the start of each phase while the user reads/moves. */
export const DEFAULT_TRANSITION_MS = 2_500;

export interface PhaseWindow {
  phase: ValidationPhase;
  startMs: number;
  endMs: number;
}

export interface PhaseResult {
  id: string;
  expected: "on_video" | "off_video";
  frames: number;
  on: number;
  off: number;
  uncertain: number;
  unavailable: number;
  /** Unavailable frames where the camera worked but no face was found (a subset of `unavailable`). */
  faceLost: number;
  /** Most common reason code among this phase's unavailable frames, or null if none were unavailable. */
  mainUnavailableReason: GazeReasonCode | null;
  /** Fraction of frames with the expected region (unavailable counts as not correct). */
  correctFraction: number | null;
  /** Drift diagnostics: median estimated position within the video (0..1; 0.5 = centre). */
  medianVideoU: number | null;
  medianVideoV: number | null;
  /** Median head movement since calibration (fraction of camera image) and distance change. */
  medianPoseShift: number | null;
  medianScaleRatio: number | null;
}

export interface ValidationResult {
  phases: PhaseResult[];
  /** Fraction of look-away frames reported as off_video. */
  lookAwayDetectionRate: number | null;
  /** Fraction of on-video frames wrongly reported as off_video (would cause a false suggestion). */
  falseAlarmRate: number | null;
  /** Fraction of on-video frames confidently reported as on_video. */
  onVideoConfirmRate: number | null;
  /** Mean of detection rate and (1 - false alarm rate); 0.5 = chance for a flag/no-flag decision. */
  balancedAccuracy: number | null;
  /**
   * Same three metrics, but counting "face lost" as looking away. Turning away often loses the face
   * entirely; whether to treat that as looking away is a product decision, so both are reported.
   */
  lookAwayInclFaceLost: number | null;
  falseAlarmInclFaceLost: number | null;
  balancedAccuracyInclFaceLost: number | null;
  /** Fraction of all scored frames with any region estimate. */
  coverage: number | null;
  /** Whether the run used a calibration, and which. */
  calibrationId: string | null;
}

/**
 * Score observations against phase windows. The first `transitionMs` of each phase is skipped.
 * Every phase counts equally within its class (per-phase rates are averaged, not pooled frames),
 * so one long phase can't dominate.
 */
export function scoreValidation(
  windows: PhaseWindow[],
  observations: GazeObservation[],
  transitionMs = DEFAULT_TRANSITION_MS,
): ValidationResult {
  const phases: PhaseResult[] = windows.map(({ phase, startMs, endMs }) => {
    const obs = observations.filter((o) => o.observed_at_ms >= startMs + transitionMs && o.observed_at_ms < endMs);
    const on = obs.filter((o) => o.gaze.region === "on_video").length;
    const off = obs.filter((o) => o.gaze.region === "off_video").length;
    const uncertain = obs.filter((o) => o.gaze.region === "uncertain").length;
    const unavailable = obs.length - on - off - uncertain;
    const faceLost = obs.filter((o) => !o.face.detected && o.reasons.includes("FACE_NOT_DETECTED")).length;
    const reasonCounts = new Map<GazeReasonCode, number>();
    for (const o of obs) {
      if (o.gaze.region !== null) continue;
      for (const r of o.reasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    }
    const mainUnavailableReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const correct = phase.expected === "on_video" ? on : off;
    return {
      id: phase.id,
      expected: phase.expected,
      frames: obs.length,
      on,
      off,
      uncertain,
      unavailable,
      faceLost,
      mainUnavailableReason,
      correctFraction: obs.length ? correct / obs.length : null,
      medianVideoU: medianOf(obs.map((o) => o.gaze.video_u)),
      medianVideoV: medianOf(obs.map((o) => o.gaze.video_v)),
      medianPoseShift: medianOf(obs.map((o) => o.face.pose_shift)),
      medianScaleRatio: medianOf(obs.map((o) => o.face.scale_ratio)),
    };
  });

  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const rate = (p: PhaseResult, k: "on" | "off") => (p.frames ? p[k] / p.frames : null);
  const onPhases = phases.filter((p) => p.expected === "on_video");
  const offPhases = phases.filter((p) => p.expected === "off_video");

  const lookAwayDetectionRate = mean(offPhases.map((p) => rate(p, "off")));
  const falseAlarmRate = mean(onPhases.map((p) => rate(p, "off")));
  const onVideoConfirmRate = mean(onPhases.map((p) => rate(p, "on")));
  const balanced = (d: number | null, fa: number | null) => (d !== null && fa !== null ? (d + 1 - fa) / 2 : null);
  const balancedAccuracy = balanced(lookAwayDetectionRate, falseAlarmRate);
  const awayOrLost = (p: PhaseResult) => (p.frames ? (p.off + p.faceLost) / p.frames : null);
  const lookAwayInclFaceLost = mean(offPhases.map(awayOrLost));
  const falseAlarmInclFaceLost = mean(onPhases.map(awayOrLost));
  const total = phases.reduce((s, p) => s + p.frames, 0);
  const withRegion = phases.reduce((s, p) => s + p.on + p.off + p.uncertain, 0);

  const scored = observations.find((o) => o.calibration.id !== null);
  return {
    phases,
    lookAwayDetectionRate,
    falseAlarmRate,
    onVideoConfirmRate,
    balancedAccuracy,
    lookAwayInclFaceLost,
    falseAlarmInclFaceLost,
    balancedAccuracyInclFaceLost: balanced(lookAwayInclFaceLost, falseAlarmInclFaceLost),
    coverage: total ? withRegion / total : null,
    calibrationId: scored?.calibration.id ?? null,
  };
}

function medianOf(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
