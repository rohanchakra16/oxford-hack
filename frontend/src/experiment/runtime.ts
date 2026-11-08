import type { AttentionTimelineStore } from '../attention';
import { replayScore, type EegReplay } from './csv';

export interface ExperimentPlayer {
  getState(): { mediaTimeS: number; paused: boolean; seeking: boolean; buffering: boolean; ended: boolean };
  subscribe?(listener: () => void): () => void;
}
export interface ExperimentReading {
  eeg: number | null;
  combined: number | null;
  gaze: { x: number; y: number; away: boolean };
  ended: boolean;
}

export function randomGaze(random = Math.random): ExperimentReading['gaze'] {
  const x = random(), y = random();
  return { x, y, away: x < .15 || x > .85 || y < .15 || y > .85 };
}

/** This runtime only writes to the experiment's private, nonpersistent store. */
export class ExperimentReplay {
  private gaze: ExperimentReading['gaze'];
  private last: number | null = null;
  private segment = 0;
  private lowSince: number | null = null;
  private lastMarker = -Infinity;
  private readonly session = `experiment:${globalThis.crypto.randomUUID()}`;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubscribe?: () => void;

  constructor(private store: AttentionTimelineStore, private player: ExperimentPlayer,
    private videoId: string, private replay: EegReplay, private report: (reading: ExperimentReading) => void,
    private random = Math.random) { this.gaze = randomGaze(random); }

  start() {
    if (this.timers.length) return;
    this.tick();
    this.unsubscribe = this.player.subscribe?.(() => this.tick());
    this.timers = [setInterval(() => this.tick(), 250), setInterval(() => {
      this.gaze = randomGaze(this.random);
      this.tick();
    }, 10_000)];
  }

  stop() {
    this.timers.forEach(clearInterval); this.timers = [];
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.last = null; this.lowSince = null; this.segment++;
  }

  private tick() {
    const state = this.player.getState(), time = state.mediaTimeS;
    const eeg = replayScore(this.replay, time);
    const combined = eeg === null ? null : .8 * eeg + (this.gaze.away ? 0 : 20);
    const ended = time >= this.replay.durationS;
    this.report({ eeg, combined, gaze: this.gaze, ended });
    this.store.setAvailability(combined === null ? { state: 'unavailable', message: ended ? 'EEG CSV finished. Rewind the lecture to replay it.' : 'No usable EEG in this CSV window.' } : { state: 'available' });
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
      valid: combined !== null, origin: 'simulated', threshold: 40, thresholdVersion: 'csv-test-v1',
      provenance: 'Local EEG CSV test · 80% EEG + 20% randomized gaze · not a validated model' });
    if (combined === null || combined > 40) { this.lowSince = null; return; }
    this.lowSince ??= time;
    if (time - this.lowSince >= 8 && time - this.lastMarker >= 30) {
      this.store.addMarker({ id: `${this.session}:${this.segment}:${time}`, startS: this.lowSince, endS: time,
        kind: 'review', origin: 'simulated', label: 'Experimental EEG + mock gaze', score: combined,
        reason: 'Test combined score stayed low for 8 seconds. Gaze is randomized.' });
      this.lastMarker = time;
      this.lowSince = null;
    }
  }
}
