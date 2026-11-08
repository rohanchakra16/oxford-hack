import type { AttentionTimelineStore } from '../attention';
import { replayScore, type EegReplay } from './csv';
import type { GazeSample } from '../focus/gazeLive';

export const EXPERIMENT_LOW_THRESHOLD = 35;

export interface ExperimentPlayer {
  getState(): { mediaTimeS: number; paused: boolean; seeking: boolean; buffering: boolean; ended: boolean };
  subscribe?(listener: () => void): () => void;
}
export interface ExperimentReading {
  eeg: number | null;
  combined: number | null;
  gaze: { x: number | null; y: number | null; away: boolean | null;
    source: 'randomized' | 'webcam'; state: GazeSample['state']; reason: string | null };
  ended: boolean;
}

export function randomGaze(random = Math.random): { x: number; y: number; away: boolean } {
  const x = random(), y = random();
  return { x, y, away: x < .15 || x > .85 || y < .15 || y > .85 };
}

/** This runtime only writes to the experiment's private, nonpersistent store. */
export class ExperimentReplay {
  private gaze: ReturnType<typeof randomGaze> | null;
  private last: number | null = null;
  private segment = 0;
  private lowSince: number | null = null;
  private lastMarker = -Infinity;
  private readonly session = `experiment:${globalThis.crypto.randomUUID()}`;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubscribe?: () => void;

  constructor(private store: AttentionTimelineStore, private player: ExperimentPlayer,
    private videoId: string, private replay: EegReplay, private report: (reading: ExperimentReading) => void,
    private random = Math.random, private readWebcam?: () => GazeSample | null) {
    this.gaze = readWebcam ? null : randomGaze(random);
  }

  start() {
    if (this.timers.length) return;
    this.tick();
    this.unsubscribe = this.player.subscribe?.(() => this.tick());
    this.timers = [setInterval(() => this.tick(), 250)];
    if (!this.readWebcam) this.timers.push(setInterval(() => {
      this.gaze = randomGaze(this.random);
      this.tick();
    }, 10_000));
  }

  stop() {
    this.timers.forEach(clearInterval); this.timers = [];
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.last = null; this.lowSince = null; this.segment++;
  }

  private tick() {
    const state = this.player.getState(), time = state.mediaTimeS;
    const eeg = replayScore(this.replay, time);
    const sample = this.readWebcam?.();
    const gaze: ExperimentReading['gaze'] = this.readWebcam
      ? { x: sample?.viewport?.x ?? null, y: sample?.viewport?.y ?? null,
        away: sample?.state === 'off' ? true : sample?.state === 'on' ? false : null,
        source: 'webcam', state: sample?.state ?? 'lost', reason: sample?.reason ?? null }
      : { ...this.gaze!, source: 'randomized', state: this.gaze!.away ? 'off' : 'on', reason: null };
    const combined = eeg === null || gaze.away === null ? null : .8 * eeg + (gaze.away ? 0 : 20);
    const ended = time >= this.replay.durationS;
    this.report({ eeg, combined, gaze, ended });
    const missing = ended ? 'EEG CSV finished. Rewind the lecture to replay it.'
      : eeg === null ? 'No usable EEG in this CSV window.'
      : 'Webcam gaze is unavailable or uncertain. Calibrate the camera and keep your face visible.';
    this.store.setAvailability(combined === null ? { state: 'unavailable', message: missing } : { state: 'available' });
    // Even a brief camera interruption between playback ticks breaks continuous low dwell.
    if (combined === null) this.lowSince = null;
    if (state.paused || state.seeking || state.buffering || state.ended) {
      if (this.last !== null) this.segment++;
      this.last = null; this.lowSince = null;
      return;
    }
    if (time === this.last) return;
    if (this.last !== null && (time < this.last || time - this.last > 2)) { this.segment++; this.lowSince = null; }
    this.last = time;
    this.store.record({ sessionId: this.session, videoId: this.videoId, segmentId: String(this.segment),
      evidence: null, mediaS: time, metric: 'experimental_csv_combined', value: combined, scale: 'score_0_100',
      valid: combined !== null, origin: 'simulated', threshold: EXPERIMENT_LOW_THRESHOLD, thresholdVersion: 'csv-test-v2',
      provenance: `Local EEG CSV test · 80% EEG + 20% ${gaze.source === 'webcam' ? 'calibrated webcam' : 'randomized'} gaze · not a validated model` });
    if (combined === null || combined > EXPERIMENT_LOW_THRESHOLD) { this.lowSince = null; return; }
    this.lowSince ??= time;
    if (time - this.lowSince >= 8 && time - this.lastMarker >= 30) {
      this.store.addMarker({ id: `${this.session}:${this.segment}:${time}`, startS: this.lowSince, endS: time,
        kind: 'review', origin: 'simulated', label: `Experimental EEG + ${gaze.source === 'webcam' ? 'webcam' : 'mock'} gaze`, score: combined,
        reason: `Test combined score stayed low for 8 seconds. Gaze is ${gaze.source === 'webcam' ? 'from the calibrated webcam' : 'randomized'}.` });
      this.lastMarker = time;
      this.lowSince = null;
    }
  }
}
