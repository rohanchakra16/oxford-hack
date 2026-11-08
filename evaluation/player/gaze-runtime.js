// Keep the gaze package behind its own compiler settings; the evaluation UI
// uses the small, typed public boundary in gaze-runtime.d.ts.
import { GazeEngine } from '../../gaze/src/engine';
import { toContractObservation, toContractCalibration, gazeProvenance, ObservationBatcher } from '../../gaze/src/contract';
import { viewportToScreen } from '../../gaze/src/geometry';
import { validSavedGaze } from './gaze-memory';

/**
 * @param {Parameters<import('./gaze-runtime').createGazeCamera>[0]} options
 * @returns {import('./gaze-runtime').GazeCamera}
 */
export function createGazeCamera({ getVideoElement, onObservation, onObservationBatch, onCalibration, onUnavailable }) {
  const engine = new GazeEngine({ sessionId: `evaluation-${crypto.randomUUID()}`, getVideoElement });
  const batcher = new ObservationBatcher((batch) => onObservationBatch?.(batch));
  let validating = false;
  let activeCheck = null;
  const cameraSettings = () => {
    const settings = engine.camera.video.srcObject?.getVideoTracks?.()[0]?.getSettings();
    return { deviceId: settings?.deviceId ?? '', width: settings?.width ?? 0, height: settings?.height ?? 0 };
  };
  engine.on('observation', (observation) => {
    if (validating && activeCheck && observation.status === 'valid' && !observation.reasons.length
      && !observation.face.eyes_closed && observation.calibration.status === 'valid'
      && Number.isFinite(observation.gaze.screen_x_px) && Number.isFinite(observation.gaze.screen_y_px)) {
      activeCheck.push({ x: observation.gaze.screen_x_px, y: observation.gaze.screen_y_px });
    }
    const frame = toContractObservation(observation);
    if (validating || observation.status !== 'valid' || observation.reasons.length || observation.face.eyes_closed || observation.calibration.status !== 'valid') {
      frame.valid = false;
      frame.insideVideo = frame.videoPoint = frame.modelConfidence = null;
      if (!frame.invalidReasons.length) frame.invalidReasons = [observation.calibration.status !== 'valid' ? 'calibration_invalid' : observation.face.eyes_closed ? 'eyes_not_detected' : 'low_confidence'];
    }
    onObservation(frame);
    if (onObservationBatch) batcher.push(frame);
  });
  engine.on('calibrationState', (event) => {
    const state = validating ? { ...event, status: 'in_progress', reason: null } : event;
    onCalibration({ id: state.attempt.id, status: state.status,
      contract: toContractCalibration(state, gazeProvenance('live', 'gaze-0.1.0')) });
  });
  engine.on('camera', (state) => { if (state.status === 'error') onUnavailable(state.message); });
  return {
    async start() {
      await engine.start();
      if (engine.camera.state.status !== 'live') throw new Error('Camera unavailable. Allow camera access and try again.');
    },
    calibrate: (ui, signal) => engine.calibrate(ui, { signal }),
    getCalibration: () => {
      const model = engine.getCalibration();
      if (!model || validating || engine.getCalibrationState()?.status !== 'valid') return null;
      return { version: 1, savedAt: Date.now(), camera: cameraSettings(), model };
    },
    clearCalibration: () => engine.setCalibration(null),
    async restoreCalibration(saved, ui, signal) {
      const camera = cameraSettings();
      if (!validSavedGaze(saved) || JSON.stringify(camera) !== JSON.stringify(saved.camera)) {
        throw new Error('Saved calibration does not match this camera. Calibrate again.');
      }
      const wait = (ms) => new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
        signal.addEventListener('abort', cancel, { once: true });
      });
      const points = [{ x: .25, y: .35 }, { x: .75, y: .65 }, { x: .5, y: .5 }];
      const model = { ...saved.model, id: `restored-${crypto.randomUUID()}`, geometry: undefined };
      validating = true;
      engine.setCalibration(model);
      try {
        for (const [index, point] of points.entries()) {
          const target = { x: point.x * window.innerWidth, y: point.y * window.innerHeight };
          ui.show(target, index, points.length);
          await wait(1000); // settle both the eyes and the existing gaze smoother
          activeCheck = [];
          await wait(800);
          const frames = activeCheck;
          activeCheck = null;
          const screen = viewportToScreen(target);
          const rms = (axis) => Math.sqrt(frames.reduce((sum, f) => sum + (f[axis] - screen[axis]) ** 2, 0) / frames.length);
          if (frames.length < 4 || rms('x') > Math.min(window.innerWidth * .2, Math.max(60, model.heldoutRmsXPx * 1.5))
            || rms('y') > Math.min(window.innerHeight * .2, Math.max(60, model.heldoutRmsYPx * 1.5))) {
            throw new Error('Camera check did not match your saved calibration. Calibrate again.');
          }
        }
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        validating = false;
        engine.setCalibration(model); // current-session ID, timestamp and geometry; announce only after validation
      } catch (error) {
        validating = false;
        engine.setCalibration(null);
        throw error;
      } finally { validating = false; activeCheck = null; ui.hide(); }
    },
    stop: () => { batcher.dispose(); engine.stop(); },
  };
}
