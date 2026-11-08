// Keep the gaze package behind its own compiler settings; the evaluation UI
// uses the small, typed public boundary in gaze-runtime.d.ts.
import { GazeEngine } from '../../gaze/src/engine';
import { toContractObservation, toContractCalibration, gazeProvenance, ObservationBatcher } from '../../gaze/src/contract';
import { viewportToScreen, screenToViewport } from '../../gaze/src/geometry';
import { validSavedGaze } from './gaze-memory';

/**
 * Local-only view of one frame for on-screen feedback (crosshair, border, gaze timeline). It is never sent
 * anywhere. `state` follows the same validity rule as the contract frame: anything that would not count as a
 * valid observation (no calibration, face or eyes lost, a reported reason) is `lost`, never `on` or `off`.
 */
function toLocalSample(observation) {
  const g = observation.gaze;
  const usable = observation.status === 'valid' && !observation.reasons.length && !observation.face.eyes_closed
    && observation.calibration.status === 'valid' && Number.isFinite(g.screen_x_px) && Number.isFinite(g.screen_y_px) && g.region;
  const state = !usable ? 'lost' : g.region === 'on_video' ? 'on' : g.region === 'off_video' ? 'off' : 'uncertain';
  return {
    tMs: observation.observed_at_ms,
    state,
    viewport: usable ? screenToViewport({ x: g.screen_x_px, y: g.screen_y_px }) : null,
    pInside: usable && Number.isFinite(g.p_inside) ? g.p_inside : null,
    reason: usable ? null : (observation.reasons[0] ?? (observation.calibration.status !== 'valid' ? 'calibration_invalid' : observation.face.eyes_closed ? 'eyes_closed' : 'unavailable')),
  };
}

/**
 * @param {Parameters<import('./gaze-runtime').createGazeCamera>[0]} options
 * @returns {import('./gaze-runtime').GazeCamera}
 */
export function createGazeCamera({ getVideoElement, onObservation, onObservationBatch, onCalibration, onUnavailable, onSample }) {
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
    if (onSample && !validating) onSample(toLocalSample(observation));
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
  let lastFailure = null;
  engine.on('camera', (state) => { if (state.status === 'error') { lastFailure = state; onUnavailable(state.message); } else if (state.status === 'starting') lastFailure = null; });
  return {
    async start() {
      let startError;
      try { await engine.start(); } catch (error) { startError = error; }
      const camera = engine.camera.state;
      if (camera.status !== 'live') {
        // Report the camera's own cause (not whatever later step failed) so the UI can give matching advice.
        throw Object.assign(new Error(camera.message || lastFailure?.message || 'Camera unavailable'), { code: camera.reason || lastFailure?.reason });
      }
      if (startError) throw startError;
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
