import type { GazeObservation, GazeCalibration } from '../../frontend/src/contracts/generated/types';

// Keep the gaze implementation behind its own compiler settings, as with GazeCamera.
export interface SavedGazeModel {
  id: string;
  createdAtMs: number;
  method: 'dots' | 'pursuit';
  featureKeys: string[];
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
  lagMs: number;
  fitSamples: number;
  fitRmsPx: number;
  heldoutErrorsPx: number[];
  heldoutRmsPx: number;
  heldoutRmsXPx: number;
  heldoutRmsYPx: number;
  marginPx: number;
  marginXPx: number;
  marginYPx: number;
  quality: 'fine' | 'coarse' | 'unusable';
  qualityX: 'fine' | 'coarse' | 'unusable';
  qualityY: 'fine' | 'coarse' | 'unusable';
  baseline: { faceCenterX: number; faceCenterY: number; faceScale: number };
}

export interface SavedGazeCalibration {
  version: 1;
  savedAt: number;
  camera: { deviceId: string; width: number; height: number };
  model: SavedGazeModel;
}

export interface CalibrationUI {
  show(point: { x: number; y: number }, step: number, total: number): void;
  hide(): void;
}

/** Local-only frame summary for on-screen feedback; never sent to the backend. */
export interface GazeSample {
  tMs: number;
  state: 'on' | 'off' | 'uncertain' | 'lost';
  /** Estimated gaze in viewport CSS px; null whenever the state is `lost`. */
  viewport: { x: number; y: number } | null;
  pInside: number | null;
  /** Why the frame is `lost` (null otherwise). */
  reason: string | null;
}

export interface GazeCamera {
  start(): Promise<void>;
  calibrate(ui: {
    show(point: { x: number; y: number }, step: number, total: number): void;
    hide(): void;
  }, signal: AbortSignal): Promise<unknown>;
  stop(): void;
  getCalibration(): SavedGazeCalibration | null;
  restoreCalibration(saved: SavedGazeCalibration, ui: CalibrationUI, signal: AbortSignal): Promise<void>;
  clearCalibration(): void;
}

export function createGazeCamera(options: {
  getVideoElement(): HTMLVideoElement;
  onObservation(observation: GazeObservation): void;
  onObservationBatch?(observations: GazeObservation[]): void;
  onSample?(sample: GazeSample): void;
  onCalibration(event: { id: string; status: 'in_progress' | 'valid' | 'invalid' | 'expired'; contract?: Omit<GazeCalibration, 'provenance'> }): void;
  onUnavailable(message: string): void;
}): GazeCamera;
