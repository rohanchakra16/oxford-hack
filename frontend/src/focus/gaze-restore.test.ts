import { afterEach, expect, it, vi } from 'vitest';
import type { GazeObservation } from '../contracts/generated/types';
import { createGazeCamera } from '../../../evaluation/player/gaze-runtime';
import type { SavedGazeCalibration, SavedGazeModel } from '../../../evaluation/player/gaze-runtime';

const { listeners, active } = vi.hoisted(() => ({
  listeners: {} as Record<string, (value: unknown) => void>, active: { model: null as SavedGazeModel | null },
}));
vi.mock('../../../gaze/src/engine', () => ({ GazeEngine: class {
  camera = { video: { srcObject: { getVideoTracks: () => [{ getSettings: () => ({ deviceId: 'camera', width: 640, height: 480 }) }] } } };
  on(name: string, callback: (value: unknown) => void) { listeners[name] = callback; }
  getCalibration() { return active.model; }
  setCalibration(model: SavedGazeModel | null) {
    const previous = active.model; active.model = model;
    listeners.calibrationState?.({ status: model ? 'valid' : 'invalid', model: model ?? previous,
      attempt: { id: (model ?? previous)?.id, method: 'dots', geometry: {
        viewportCssPx: { x: 0, y: 0, width: 1000, height: 800 }, videoRectCssPx: { x: 0, y: 0, width: 800, height: 600 },
      } }, reason: null, tBrowserMs: performance.now() });
  }
  stop() {}
} }));

const saved = (): SavedGazeCalibration => ({ version: 1, savedAt: Date.now(), camera: { deviceId: 'camera', width: 640, height: 480 },
  model: { id: 'old-session', createdAtMs: Date.now(), method: 'dots', featureKeys: ['irisX'],
    mean: [0], std: [1], wx: [0, 1], wy: [0, 1], lagMs: 0, fitSamples: 20, fitRmsPx: 10,
    heldoutErrorsPx: [10], heldoutRmsPx: 10, heldoutRmsXPx: 10, heldoutRmsYPx: 10,
    marginPx: 25, marginXPx: 25, marginYPx: 25, quality: 'fine', qualityX: 'fine', qualityY: 'fine',
    baseline: { faceCenterX: .5, faceCenterY: .5, faceScale: 1 } } });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); active.model = null; });

it('keeps restored gaze invalid until a current-camera check succeeds, then uses a fresh session calibration', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, outerHeight: 800, screenX: 0, screenY: 0 });
  const frames: GazeObservation[] = [];
  const states: string[] = [];
  const camera = createGazeCamera({ getVideoElement: () => null!, onObservation: (frame) => frames.push(frame),
    onCalibration: (event) => states.push(event.status), onUnavailable: () => {} });
  let target = { x: 0, y: 0 };
  let seq = 0;
  const emit = () => listeners.observation!({ session_id: 'current', frame_seq: ++seq, observed_at_ms: seq * 100,
    processed_at_ms: seq * 100, status: 'valid', reasons: [], calibration: { id: active.model?.id, status: 'valid' },
    face: { eyes_closed: false }, gaze: { screen_x_px: target.x, screen_y_px: target.y, region: 'on_video', video_u: .5, video_v: .5, p_inside: .9 } });
  const timer = setInterval(emit, 100);
  const pending = camera.restoreCalibration(saved(), { show: (point) => { target = point; }, hide() {} }, new AbortController().signal);
  expect(states).toEqual(['in_progress']);
  await vi.advanceTimersByTimeAsync(5300);
  expect(frames.length).toBeGreaterThan(20);
  expect(frames.every((f) => !f.valid && f.videoPoint === null)).toBe(true);
  expect(states).not.toContain('valid');
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  clearInterval(timer);
  expect(states.at(-1)).toBe('valid');
  expect(active.model?.id).not.toBe('old-session');
  emit(); expect(frames.at(-1)?.valid).toBe(true);
  camera.stop();
});

it('refuses a different camera and clears a restored model when validation is cancelled', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, outerHeight: 800, screenX: 0, screenY: 0 });
  const states: string[] = [];
  const camera = createGazeCamera({ getVideoElement: () => null!, onObservation() {}, onCalibration: (event) => states.push(event.status), onUnavailable() {} });
  const ui = { show() {}, hide() {} };
  await expect(camera.restoreCalibration({ ...saved(), camera: { deviceId: 'different', width: 640, height: 480 } }, ui, new AbortController().signal)).rejects.toThrow('match this camera');
  expect(states).toEqual([]);
  const controller = new AbortController();
  const pending = camera.restoreCalibration(saved(), ui, controller.signal);
  const failed = expect(pending).rejects.toThrow('Cancelled');
  controller.abort();
  await failed;
  expect(active.model).toBeNull();
  expect(states).not.toContain('valid');
  camera.stop();
});
