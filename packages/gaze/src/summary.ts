import { GAZE_SUMMARY_SCHEMA, type GazeObservation, type GazeReasonCode, type GazeSummary } from "./types";

/**
 * Builds a summary over observations in [startMs, endMs).
 * Off-video runs are measured between consecutive observation timestamps and are broken by
 * any observation that is not off_video (including unavailable ones), so missing data
 * never counts as looking away.
 */
export function summarise(
  sessionId: string,
  observations: GazeObservation[],
  startMs: number,
  endMs: number,
): GazeSummary {
  const obs = observations
    .filter((o) => o.observed_at_ms >= startMs && o.observed_at_ms < endMs)
    .sort((a, b) => a.observed_at_ms - b.observed_at_ms);
  const n = obs.length;
  const withRegion = obs.filter((o) => o.gaze.region !== null);
  const count = (r: string) => withRegion.filter((o) => o.gaze.region === r).length;
  const frac = (k: number) => (withRegion.length ? k / withRegion.length : null);

  let longest = 0;
  let runStart: number | null = null;
  let last: number | null = null;
  for (const o of obs) {
    if (o.gaze.region === "off_video") {
      runStart ??= o.observed_at_ms;
      last = o.observed_at_ms;
      longest = Math.max(longest, last - runStart);
    } else {
      runStart = null;
    }
  }

  const faceMeasured = obs.filter((o) => o.face.eyes_closed !== null);
  const reasonCounts = new Map<GazeReasonCode, number>();
  for (const o of obs) for (const r of o.reasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r]) => r);

  return {
    schema: GAZE_SUMMARY_SCHEMA,
    session_id: sessionId,
    window_start_ms: startMs,
    window_end_ms: endMs,
    frames_processed: n,
    valid_coverage: n ? withRegion.length / n : 0,
    on_video_fraction: frac(count("on_video")),
    off_video_fraction: frac(count("off_video")),
    uncertain_fraction: frac(count("uncertain")),
    longest_off_video_ms: longest,
    face_missing_fraction: n ? obs.filter((o) => !o.face.detected).length / n : 0,
    eyes_closed_fraction: faceMeasured.length
      ? faceMeasured.filter((o) => o.face.eyes_closed).length / faceMeasured.length
      : null,
    top_reasons: topReasons,
  };
}
