/**
 * Gaze capture: a JSONL file of real webcam output in the shared contract format, for replaying
 * through inference (@Seikaro) and the platform (@rohanchakra16) instead of synthetic data.
 *
 * This is NOT the backend's `oxford-hack-recording` replay format: that one records a whole
 * session (session_start, playback, clock offsets) on the backend clock, which the standalone
 * harness doesn't have. A capture holds only browser-side gaze messages on the browser clock,
 * plus optional ground-truth labels from the scripted accuracy test, so it can be spliced into a
 * recording or fed to the inference adapter after clock mapping.
 *
 * Line 1 is a header; every other line is one of:
 *   {"kind":"message","tBrowserMs":…,"message":{<gaze_calibration | gaze_observations envelope>}}
 *   {"kind":"label","phaseId":…,"expected":"on_video"|"off_video","startBrowserMs":…,"endBrowserMs":…,
 *    "scoredFromBrowserMs":…,"instruction":…}
 */
import type { CalibrationStateEvent } from "./engine";
import {
  CONTRACT_SCHEMA_VERSION,
  gazeProvenance,
  ObservationBatcher,
  PRODUCER,
  toContractCalibration,
  toContractId,
  toContractObservation,
  type ContractGazeCalibration,
  type ContractGazeObservation,
  type ContractProvenance,
  type RunKind,
} from "./contract";
import type { GazeObservation } from "./types";
import type { PhaseWindow } from "./validation";

export const CAPTURE_FORMAT = "oxford-hack-gaze-capture";
export const CAPTURE_FORMAT_VERSION = 1;

export interface CaptureHeader {
  format: typeof CAPTURE_FORMAT;
  formatVersion: number;
  schemaVersion: string;
  runKind: RunKind;
  producer: string;
  producerVersion: string;
  sessionId: string;
  createdAt: string;
  clock: string;
  description: string;
}

export type GazeEnvelope =
  | { schemaVersion: string; messageId: string; sessionId: string; seq: number; type: "gaze_observations"; payload: { observations: ContractGazeObservation[]; provenance: ContractProvenance } }
  | { schemaVersion: string; messageId: string; sessionId: string; seq: number; type: "gaze_calibration"; payload: ContractGazeCalibration };

export type CaptureLine =
  | { kind: "message"; tBrowserMs: number; message: GazeEnvelope }
  | {
      kind: "label";
      phaseId: string;
      expected: "on_video" | "off_video";
      startBrowserMs: number;
      endBrowserMs: number;
      /** Start of the scored part (after the transition the accuracy test ignores). */
      scoredFromBrowserMs: number;
      instruction: string;
    };

export class GazeCaptureRecorder {
  readonly header: CaptureHeader;
  private readonly lines: CaptureLine[] = [];
  private readonly sessionId: string;
  private readonly provenance: ContractProvenance;
  private readonly batcher: ObservationBatcher;
  private seq = 0;
  private observationCount = 0;

  constructor(opts: {
    sessionId: string;
    producerVersion: string;
    runKind?: RunKind;
    description?: string;
    now?: () => number;
    flushMs?: number;
  }) {
    this.now = opts.now ?? (() => performance.now());
    this.sessionId = toContractId(opts.sessionId);
    this.provenance = gazeProvenance(opts.runKind ?? "live", opts.producerVersion);
    this.header = {
      format: CAPTURE_FORMAT,
      formatVersion: CAPTURE_FORMAT_VERSION,
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runKind: this.provenance.runKind,
      producer: PRODUCER,
      producerVersion: opts.producerVersion,
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      clock: "tBrowserMs and all payload *BrowserMs/tBrowser* fields are browser performance.now() ms, not backend time",
      description: opts.description ?? "Real webcam gaze capture from the gaze harness (no images).",
    };
    this.batcher = new ObservationBatcher((batch) => this.pushMessage("gaze_observations", { observations: batch, provenance: this.provenance }), {
      flushMs: opts.flushMs,
    });
  }

  private readonly now: () => number;

  private pushMessage(type: "gaze_observations" | "gaze_calibration", payload: unknown) {
    const seq = this.seq++;
    const message = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      messageId: toContractId(`gzcap-${this.sessionId}-${seq}`),
      sessionId: this.sessionId,
      seq,
      type,
      payload,
    } as GazeEnvelope;
    this.lines.push({ kind: "message", tBrowserMs: this.now(), message });
  }

  observation(o: GazeObservation): void {
    this.observationCount++;
    this.batcher.push(toContractObservation(o));
  }

  calibration(e: CalibrationStateEvent): void {
    // Keep ordering: observations made before this calibration change are written first.
    this.batcher.flush();
    this.pushMessage("gaze_calibration", toContractCalibration(e, this.provenance));
  }

  label(w: PhaseWindow, transitionMs: number): void {
    this.batcher.flush();
    this.lines.push({
      kind: "label",
      phaseId: w.phase.id,
      expected: w.phase.expected,
      startBrowserMs: w.startMs,
      endBrowserMs: w.endMs,
      scoredFromBrowserMs: Math.min(w.endMs, w.startMs + transitionMs),
      instruction: w.phase.instruction,
    });
  }

  /** Number of observations and lines so far (for UI counters). */
  get size(): { observations: number; lines: number } {
    return { observations: this.observationCount, lines: this.lines.length };
  }

  /** Flush pending observations and return the capture as JSONL. Can be called repeatedly. */
  toJsonl(): string {
    this.batcher.flush();
    return [this.header, ...this.lines].map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  dispose(): void {
    this.batcher.dispose();
  }
}
