import { beforeEach, describe, expect, it, vi } from '../../frontend/node_modules/vitest';
import { GazeWindowBuffer } from './gaze';

function frame(time: number, inside: boolean, valid = true): Parameters<GazeWindowBuffer['push']>[0] {
  return {
    observationId: `frame-${time}`, tBrowserFrameMs: time, tBrowserProcessedMs: time,
    measurementKind: 'screen_gaze', calibrationId: 'cal-1', valid,
    invalidReasons: valid ? [] : ['eyes_not_detected'],
    videoPoint: valid ? { x: inside ? 0.5 : 2, y: 0.5 } : null,
    insideVideo: valid ? inside : null, modelConfidence: valid ? 0.9 : null,
  };
}

describe('gaze windows for combined detection', () => {
  beforeEach(() => vi.stubGlobal('document', { hidden: false }));

  it('uses elapsed time rather than the number of frames for look-away', () => {
    const buffer = new GazeWindowBuffer();
    buffer.clear('cal-1');
    for (let time = 0; time < 500; time += 50) buffer.push(frame(time, true));
    for (let time = 500; time < 1000; time += 100) buffer.push(frame(time, false));
    const window = buffer.read(1000)!;
    expect(window.validFraction).toBe(1);
    expect(window.outsideFraction).toBe(0.5);
  });

  it('treats eye loss as missing coverage, never as looking away', () => {
    const buffer = new GazeWindowBuffer();
    buffer.clear('cal-1');
    for (let time = 0; time < 1000; time += 100) buffer.push(frame(time, true, time < 400));
    const window = buffer.read(1000)!;
    expect(window.validFraction).toBe(0.4);
    expect(window.outsideFraction).toBe(0);
  });

  it('exposes camera gaps and staleness even when its last result was valid', () => {
    const buffer = new GazeWindowBuffer();
    buffer.clear('cal-1');
    buffer.push(frame(0, false)); buffer.push(frame(100, false));
    const window = buffer.read(1000)!;
    expect(window.maxGapMs).toBe(900);
    expect(window.newestAgeMs).toBe(900);
    expect(window.validFraction).toBe(0.1);
  });

  it('requires the active calibration and discards older calibration evidence', () => {
    const buffer = new GazeWindowBuffer();
    for (let time = 0; time < 1000; time += 100) buffer.push(frame(time, false));
    expect(buffer.read(1000)).toBeNull();
    buffer.clear('cal-2');
    for (let time = 0; time < 1000; time += 100) buffer.push(frame(time, false));
    expect(buffer.read(1000)!.validFraction).toBe(0);
  });

  it('rejects hidden-tab evidence and future frames', () => {
    const buffer = new GazeWindowBuffer();
    buffer.clear('cal-1'); buffer.push(frame(1100, false));
    expect(buffer.read(1000)).toBeNull();
    vi.stubGlobal('document', { hidden: true });
    expect(buffer.read(1200)).toBeNull();
  });
});
