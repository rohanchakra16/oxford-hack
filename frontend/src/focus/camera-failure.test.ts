import { expect, it } from 'vitest';
import { explainCameraFailure } from '../../../evaluation/player/GazeCalibration';

it('classifies recognised camera causes', () => {
  expect(explainCameraFailure(new DOMException('x', 'NotAllowedError')).kind).toBe('permission');
  expect(explainCameraFailure({ name: 'NotFoundError' }).kind).toBe('missing');
  expect(explainCameraFailure({ name: 'NotReadableError' }).kind).toBe('busy');
});

it('shows a saved-setup mismatch as itself, not as a camera failure', () => {
  for (const message of ['Camera check did not match your saved calibration. Calibrate again.', 'Saved calibration does not match this camera. Calibrate again.']) {
    const f = explainCameraFailure(new Error(message));
    expect(f.message).toContain(message);
    expect(f.message).not.toMatch(/cause could not be identified|Camera setup failed/);
  }
});
