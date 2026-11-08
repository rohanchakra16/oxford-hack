import { expect, it, vi } from 'vitest';
import { createGazeCamera } from '../../../evaluation/player/gaze-runtime';
import type { GazeSample } from '../../../evaluation/player/gaze-runtime';

const { listeners } = vi.hoisted(() => ({ listeners: {} as Record<string, (value: unknown) => void> }));
vi.mock('../../../gaze/src/engine', () => ({ GazeEngine: class {
  on(name: string, callback: (value: unknown) => void) { listeners[name] = callback; }
  stop() {}
} }));
vi.mock('../../../gaze/src/geometry', () => ({ viewportToScreen: (p: unknown) => p, screenToViewport: (p: { x: number; y: number }) => ({ x: p.x - 100, y: p.y - 50 }) }));

function frame(over: Record<string, unknown> = {}, gaze: Record<string, unknown> = {}, face: Record<string, unknown> = {}, calibration = 'valid') {
  return { session_id: 't', frame_seq: 1, observed_at_ms: 100, processed_at_ms: 110, status: 'valid', reasons: [], calibration: { id: 'c', status: calibration },
    face: { eyes_closed: false, ...face }, gaze: { region: 'on_video', screen_x_px: 400, screen_y_px: 300, video_u: 0.5, video_v: 0.5, p_inside: 0.9, ...gaze }, ...over };
}
function run(observation: unknown): GazeSample {
  const samples: GazeSample[] = [];
  createGazeCamera({ getVideoElement: () => null!, onObservation: () => {}, onCalibration: () => {}, onUnavailable: () => {}, onSample: (s) => samples.push(s) });
  listeners.observation!(observation);
  return samples[0]!;
}

it('reports a calibrated on-video frame with its viewport position', () => {
  expect(run(frame())).toMatchObject({ state: 'on', viewport: { x: 300, y: 250 }, pInside: 0.9, reason: null });
});
it('reports off-video and uncertain as such, keeping a position', () => {
  expect(run(frame({}, { region: 'off_video' })).state).toBe('off');
  expect(run(frame({}, { region: 'uncertain' }))).toMatchObject({ state: 'uncertain', viewport: { x: 300, y: 250 } });
});
it.each([
  ['eyes closed', frame({}, {}, { eyes_closed: true }), 'eyes_closed'],
  ['face not measured', frame({ status: 'unavailable', reasons: ['FACE_NOT_DETECTED'] }), 'FACE_NOT_DETECTED'],
  ['no valid calibration', frame({}, {}, {}, 'stale'), 'calibration_invalid'],
  ['missing position', frame({}, { screen_x_px: null, screen_y_px: null, region: null }), 'unavailable'],
])('never reports %s as looking at or away from the video', (_name, observation, reason) => {
  const s = run(observation);
  expect(s.state).toBe('lost'); expect(s.viewport).toBeNull(); expect(s.pInside).toBeNull(); expect(s.reason).toBe(reason);
});
