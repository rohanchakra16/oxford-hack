import { expect, it, vi } from 'vitest';
import type { GazeObservation } from '../contracts/generated/types';
import { validateMessage } from '../contracts/validate';
import { createGazeCamera } from '../../../evaluation/player/gaze-runtime';

const { listeners } = vi.hoisted(() => ({ listeners: {} as Record<string, (value: unknown) => void> }));
vi.mock('../../../gaze/src/engine', () => ({ GazeEngine: class {
  on(name: string, callback: (value: unknown) => void) { listeners[name] = callback; }
  stop() {}
} }));

it.each(['stale', 'eyes_closed', 'unavailable'])('sends %s as a contract-valid missing observation, without a stale gaze point', (state) => {
  const frames: GazeObservation[] = [];
  const camera = createGazeCamera({ getVideoElement: () => null!, onObservation: (frame) => frames.push(frame), onCalibration: () => {}, onUnavailable: () => {} });
  listeners.observation!({
    session_id: 'test', frame_seq: 1, observed_at_ms: 100, processed_at_ms: 110,
    status: state === 'unavailable' ? 'unavailable' : 'valid', reasons: [],
    calibration: { id: 'cal-test', status: state === 'stale' ? 'stale' : 'valid' },
    face: { eyes_closed: state === 'eyes_closed' },
    gaze: { region: 'on_video', video_u: 0.5, video_v: 0.5, p_inside: 0.9 },
  });
  const frame = frames[0]!;
  expect(frame.valid).toBe(false);
  expect(frame.invalidReasons.length).toBeGreaterThan(0);
  expect(frame.videoPoint).toBeNull(); expect(frame.insideVideo).toBeNull(); expect(frame.modelConfidence).toBeNull();
  expect(() => validateMessage({ schemaVersion: '0.2.0', messageId: 'gaze-test', sessionId: 'session', seq: 1, type: 'gaze_observations', payload: { observations: [frame], provenance: { runKind: 'live', producer: 'test', producerVersion: '1' } } })).not.toThrow();
  camera.stop();
});
