import type { GazeObservation, GazeCalibration } from '../../frontend/src/contracts/generated/types';

export interface GazeCamera {
  start(): Promise<void>;
  calibrate(ui: {
    show(point: { x: number; y: number }, step: number, total: number): void;
    hide(): void;
  }, signal: AbortSignal): Promise<unknown>;
  stop(): void;
}

export function createGazeCamera(options: {
  getVideoElement(): HTMLVideoElement;
  onObservation(observation: GazeObservation): void;
  onObservationBatch?(observations: GazeObservation[]): void;
  onCalibration(event: { id: string; status: 'in_progress' | 'valid' | 'invalid' | 'expired'; contract?: Omit<GazeCalibration, 'provenance'> }): void;
  onUnavailable(message: string): void;
}): GazeCamera;
