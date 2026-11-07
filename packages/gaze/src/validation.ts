import type { GazeObservation } from "./types";

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
  /** Fraction of frames with the expected region (unavailable counts as not correct). */
  correctFraction: number | null;
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
    const correct = phase.expected === "on_video" ? on : off;
    return {
      id: phase.id,
      expected: phase.expected,
      frames: obs.length,
      on,
      off,
      uncertain,
      unavailable,
      correctFraction: obs.length ? correct / obs.length : null,
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
  const balancedAccuracy =
    lookAwayDetectionRate !== null && falseAlarmRate !== null ? (lookAwayDetectionRate + 1 - falseAlarmRate) / 2 : null;
  const total = phases.reduce((s, p) => s + p.frames, 0);
  const withRegion = phases.reduce((s, p) => s + p.on + p.off + p.uncertain, 0);

  const scored = observations.find((o) => o.calibration.id !== null);
  return {
    phases,
    lookAwayDetectionRate,
    falseAlarmRate,
    onVideoConfirmRate,
    balancedAccuracy,
    coverage: total ? withRegion / total : null,
    calibrationId: scored?.calibration.id ?? null,
  };
}
