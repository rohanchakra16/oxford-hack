import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMA_VERSION,
  ObservationBatcher,
  gazeProvenance,
  toContractCalibration,
  toContractObservation,
} from '../../../gaze/src/contract';
import type { CalibrationModel } from '../../../gaze/src/calibration';
import type { CalibrationStateEvent } from '../../../gaze/src/engine';
import type { GazeObservation } from '../../../gaze/src/types';
import { SCHEMA_VERSION, parseMessage } from '../contracts/validate';

/**
 * The gaze module's own adapters (not hand-built fixtures) against the shared validator: the schema
 * version must match and every payload it can emit must pass the same checks the transport applies.
 */
const face = {
  detected: true, head_yaw_deg: 1, head_pitch_deg: 2, head_roll_deg: 0, iris_x: 0, iris_y: 0,
  eye_openness: 0.9, eyes_closed: false, pose_shift: 0.01, scale_ratio: 1,
};
const calibration = {
  id: 'cal-abc', status: 'valid', quality: 'coarse', heldout_rms_px: 100, heldout_rms_x_px: 40, heldout_rms_y_px: 90,
};

function internal(seq: number, over: Partial<GazeObservation> = {}): GazeObservation {
  return {
    schema: 'gaze_observation/v0', session_id: 'compat', frame_seq: seq, observed_at_ms: 3500 + seq * 66,
    processed_at_ms: 3512 + seq * 66, wall_clock_ms: 0, status: 'valid', reasons: [], face,
    gaze: { screen_x_px: 100, screen_y_px: 100, video_u: 0.5, video_v: 0.5, region: 'on_video', p_inside: 0.9, sigma_x_px: 50, sigma_y_px: 120 },
    calibration, model: { name: 'm', version: 'v' },
    ...over,
  } as GazeObservation;
}

let seq = 0;
const envelope = (type: string, payload: unknown) =>
  JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION, messageId: `g-${++seq}`, sessionId: 'ses-compat', seq, type, payload });

describe('gaze module output against the shared contract', () => {
  it('declares the shared schema version', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  it('batches valid, off-video and invalid observations that the shared validator accepts', () => {
    const provenance = gazeProvenance('live', 'compat-test');
    const batches: unknown[][] = [];
    const batcher = new ObservationBatcher((batch) => batches.push(batch), { flushMs: 1_000_000 });
    batcher.push(toContractObservation(internal(1)));
    batcher.push(toContractObservation(internal(2, { gaze: { ...internal(2).gaze!, video_u: 1.4, region: 'off_video' } })));
    batcher.push(toContractObservation(internal(3, { status: 'unavailable', reasons: ['CAMERA_DISCONNECTED'], gaze: { ...internal(3).gaze!, region: null, video_u: null, video_v: null } })));
    batcher.dispose();
    expect(batches).toHaveLength(1);
    const message = parseMessage(envelope('gaze_observations', { observations: batches[0], provenance }));
    expect(message.type).toBe('gaze_observations');
  });

  it('emits calibration messages the shared validator accepts for every status', () => {
    const geometry = { viewportCssPx: { x: 0, y: 0, width: 1280, height: 800 }, videoRectCssPx: { x: 16, y: 64, width: 892, height: 502 } };
    const attempt = { id: 'cal-xyz', method: '15-dot fit (11 fit, 4 held out), ridge', geometry } as unknown as CalibrationStateEvent['attempt'];
    const model = { fitSamples: 11, heldoutErrorsPx: [80, 100, 120, 100] } as unknown as CalibrationModel;
    const provenance = gazeProvenance('live', 'compat-test');
    for (const [status, withModel, reason] of [['in_progress', null, null], ['valid', model, null], ['invalid', null, 'fit failed'], ['expired', model, 'layout changed']] as const) {
      const event: CalibrationStateEvent = { status, attempt, model: withModel, reason, tBrowserMs: 2000 };
      const message = parseMessage(envelope('gaze_calibration', toContractCalibration(event, provenance)));
      expect(message.type).toBe('gaze_calibration');
    }
  });

  it('would be rejected by the shared validator if the gaze module spoke another version', () => {
    const provenance = gazeProvenance('live', 'compat-test');
    const stale = JSON.stringify({ schemaVersion: '0.1.0', messageId: 'g-x', sessionId: 'ses-compat', seq: 1, type: 'gaze_observations', payload: { observations: [], provenance } });
    expect(() => parseMessage(stale)).toThrowError(expect.objectContaining({ code: 'schema_version_mismatch' }));
  });
});
