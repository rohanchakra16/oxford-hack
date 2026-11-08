import { afterEach, expect, it, vi } from 'vitest';
import { readGazeMemory, resetGazeMemory, saveGazeMemory, validSavedGaze } from '../../../evaluation/player/gaze-memory';
import type { SavedGazeCalibration } from '../../../evaluation/player/gaze-runtime';

export function savedGaze(): SavedGazeCalibration {
  return { version: 1, savedAt: Date.now(), camera: { deviceId: 'test-camera', width: 640, height: 480 },
    model: { id: 'test', createdAtMs: Date.now(), method: 'dots', featureKeys: ['irisX'],
      mean: [0], std: [1], wx: [0, 1], wy: [0, 1], lagMs: 0, fitSamples: 20, fitRmsPx: 10,
      heldoutErrorsPx: [10], heldoutRmsPx: 10, heldoutRmsXPx: 10, heldoutRmsYPx: 10,
      marginPx: 25, marginXPx: 25, marginYPx: 25, quality: 'fine', qualityX: 'fine', qualityY: 'fine',
      baseline: { faceCenterX: .5, faceCenterY: .5, faceScale: 1 } } };
}

afterEach(() => vi.unstubAllGlobals());

it('keeps camera settings per participant across new sessions and resets only that profile', () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  const saved = savedGaze();
  expect(saveGazeMemory('Alice', saved)).toBe(true);
  expect(readGazeMemory('Alice')).toEqual(saved);
  expect(readGazeMemory('Bob')).toBeNull();
  saveGazeMemory('Bob', saved);
  resetGazeMemory('Alice');
  expect(readGazeMemory('Alice')).toBeNull();
  expect(readGazeMemory('Bob')).toEqual(saved);
});

it('rejects corrupt, incompatible, expired and future calibrations', () => {
  expect(validSavedGaze(savedGaze())).toBe(true);
  for (const changes of [{ version: 2 }, { savedAt: 0 }, { savedAt: Date.now() + 86400_000 },
    { camera: { deviceId: '', width: 640, height: 480 } }, { model: { ...savedGaze().model, wx: [NaN] } },
    { model: { ...savedGaze().model, quality: 'unusable' } }]) {
    expect(validSavedGaze({ ...savedGaze(), ...changes })).toBe(false);
  }
  for (const value of [null, {}, [], 'bad', { version: 1, savedAt: Date.now(), camera: {} }]) expect(validSavedGaze(value)).toBe(false);
});

it('continues without persistence when browser storage is blocked', () => {
  vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  expect(readGazeMemory('Alice')).toBeNull();
  expect(saveGazeMemory('Alice', savedGaze())).toBe(false);
});
