import type { SavedGazeCalibration } from './gaze-runtime';

const PREFIX = 'remind.gaze-calibration.v1:';
const MAX_AGE = 90 * 86400_000;
const finiteArray = (value: unknown, size?: number): value is number[] => Array.isArray(value)
  && value.length > 0 && value.length <= 64 && (size === undefined || value.length === size)
  && value.every((item) => typeof item === 'number' && Number.isFinite(item));

/** Browser storage is untrusted. Store coefficients/settings only, never frames. */
export function validSavedGaze(value: unknown, now = Date.now()): value is SavedGazeCalibration {
  if (!value || typeof value !== 'object') return false;
  const saved = value as SavedGazeCalibration;
  const m = saved.model;
  if (saved.version !== 1 || !Number.isFinite(saved.savedAt) || now < saved.savedAt || now - saved.savedAt > MAX_AGE
    || !saved.camera || typeof saved.camera.deviceId !== 'string' || !saved.camera.deviceId
    || !Number.isFinite(saved.camera.width) || saved.camera.width <= 0
    || !Number.isFinite(saved.camera.height) || saved.camera.height <= 0 || !m) return false;
  const keys = ['headYawDeg', 'headPitchDeg', 'headRollDeg', 'irisX', 'irisY', 'eyeOpenness', 'faceCenterX', 'faceCenterY', 'faceScale'];
  const n = m.featureKeys?.length;
  return typeof m.id === 'string' && !!m.id && (m.method === 'dots' || m.method === 'pursuit')
    && ['fine', 'coarse'].includes(m.quality) && ['fine', 'coarse', 'unusable'].includes(m.qualityX)
    && ['fine', 'coarse', 'unusable'].includes(m.qualityY)
    && Array.isArray(m.featureKeys) && n > 0 && n <= 9 && new Set(m.featureKeys).size === n
    && m.featureKeys.every((key) => keys.includes(key))
    && finiteArray(m.mean, n) && finiteArray(m.std, n) && m.std.every((v) => v > 0)
    && finiteArray(m.wx, n + 1) && finiteArray(m.wy, n + 1)
    && finiteArray(m.heldoutErrorsPx)
    && [m.createdAtMs, m.lagMs, m.fitSamples, m.fitRmsPx, m.heldoutRmsPx, m.heldoutRmsXPx,
      m.heldoutRmsYPx, m.marginPx, m.marginXPx, m.marginYPx].every((v) => Number.isFinite(v) && v >= 0)
    && !!m.baseline && [m.baseline.faceCenterX, m.baseline.faceCenterY, m.baseline.faceScale].every(Number.isFinite)
    && m.baseline.faceScale > 0;
}

export function readGazeMemory(participant: string): SavedGazeCalibration | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PREFIX + participant) ?? 'null');
    return validSavedGaze(saved) ? saved : null;
  } catch { return null; }
}

export function saveGazeMemory(participant: string, saved: SavedGazeCalibration): boolean {
  if (!validSavedGaze(saved)) return false;
  try { localStorage.setItem(PREFIX + participant, JSON.stringify(saved)); return true; } catch { return false; }
}

export function resetGazeMemory(participant: string): void {
  try { localStorage.removeItem(PREFIX + participant); } catch { /* Current camera can still be reset. */ }
}
