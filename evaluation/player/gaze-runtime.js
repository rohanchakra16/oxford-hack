// Keep the gaze package behind its own compiler settings; the evaluation UI
// uses the small, typed public boundary in gaze-runtime.d.ts.
import { GazeEngine } from '../../gaze/src/engine';
import { toContractObservation, toContractCalibration, gazeProvenance, ObservationBatcher } from '../../gaze/src/contract';

/**
 * @param {Parameters<import('./gaze-runtime').createGazeCamera>[0]} options
 * @returns {import('./gaze-runtime').GazeCamera}
 */
export function createGazeCamera({ getVideoElement, onObservation, onObservationBatch, onCalibration, onUnavailable }) {
  const engine = new GazeEngine({ sessionId: `evaluation-${crypto.randomUUID()}`, getVideoElement });
  const batcher = new ObservationBatcher((batch) => onObservationBatch?.(batch));
  engine.on('observation', (observation) => {
    const frame = toContractObservation(observation);
    if (observation.status !== 'valid' || observation.reasons.length || observation.face.eyes_closed || observation.calibration.status !== 'valid') {
      frame.valid = false;
      frame.insideVideo = frame.videoPoint = frame.modelConfidence = null;
      if (!frame.invalidReasons.length) frame.invalidReasons = [observation.calibration.status !== 'valid' ? 'calibration_invalid' : observation.face.eyes_closed ? 'eyes_not_detected' : 'low_confidence'];
    }
    onObservation(frame);
    if (onObservationBatch) batcher.push(frame);
  });
  engine.on('calibrationState', (event) => onCalibration({ id: event.attempt.id, status: event.status,
    contract: toContractCalibration(event, gazeProvenance('live', 'gaze-0.1.0')) }));
  engine.on('camera', (state) => { if (state.status === 'error') onUnavailable(state.message); });
  return {
    async start() {
      await engine.start();
      if (engine.camera.state.status !== 'live') throw new Error('Camera unavailable. Allow camera access and try again.');
    },
    calibrate: (ui, signal) => engine.calibrate(ui, { signal }),
    stop: () => { batcher.dispose(); engine.stop(); },
  };
}
