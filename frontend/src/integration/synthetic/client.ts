/**
 * SYNTHETIC adapter: same ReviewClient interface as the live adapter, no backend, fake data.
 * Owner: Person 5. For Person 4's UI work and component tests without EEG, webcam or backend.
 *
 * Everything it produces is labelled synthetic (connection detail, runKind 'simulated',
 * detector 'synthetic-adapter') and validated against the shared schema before use.
 *
 * It is NOT a model of the real system's timing: it derives bookmark media times directly from
 * the reported playback position. Real cross-clock mapping happens only in the backend.
 */
import { SCHEMA_VERSION, type ReviewBookmark, type SensorState, type SensorStatus } from '../../contracts/generated/types';
import { validateMessage } from '../../contracts/validate';
import { PlaybackReporter } from '../playback/reporter';
import { ClientStore } from '../store';
import { realTimers, type Timers } from '../timers';
import type {
  FeedbackAction,
  GazeCalibration,
  GazeObservation,
  MediaEventName,
  MediaSnapshot,
  ReviewClient,
  ReviewClientEvent,
  ReviewClientSnapshot,
  SessionInfo,
  StartSessionOptions,
} from '../types';

type SensorName = SensorState['state'];

export interface SyntheticSensorStep {
  /** Seconds since the session started. */
  atS: number;
  eeg: SensorName;
  gaze: SensorName;
  reason?: string;
}

export interface SyntheticScenario {
  /** Seconds of continuous playback between automatic synthetic bookmarks. */
  bookmarkEveryS: number;
  /** Seconds of playback a synthetic evidence window covers. */
  windowS: number;
  leadInS: number;
  sensors: SyntheticSensorStep[];
}

export const DEFAULT_SCENARIO: SyntheticScenario = {
  bookmarkEveryS: 25,
  windowS: 4,
  leadInS: 2,
  sensors: [
    { atS: 0, eeg: 'warming_up', gaze: 'ok' },
    { atS: 5, eeg: 'ok', gaze: 'ok' },
    { atS: 60, eeg: 'ok', gaze: 'lost', reason: 'synthetic: face not detected' },
    { atS: 75, eeg: 'ok', gaze: 'ok' },
    { atS: 120, eeg: 'lost', gaze: 'ok', reason: 'synthetic: EEG stream silent' },
    { atS: 135, eeg: 'ok', gaze: 'ok' },
  ],
};

export interface SyntheticClientOptions {
  timers?: Timers;
  scenario?: Partial<SyntheticScenario>;
  tickMs?: number;
}

interface Segment {
  id: string;
  startBrowserMs: number;
  startMediaS: number;
  rate: number;
  lastBookmarkMediaS: number;
}

let msgN = 0;

/** Throws if `payload` is not a valid `type` message: keeps synthetic data on-contract. */
function checked<T>(type: string, payload: T, sessionId: string | null): T {
  validateMessage({ schemaVersion: SCHEMA_VERSION, messageId: `syn-${++msgN}`, sessionId, seq: 0, type, payload });
  return payload;
}

export class SyntheticReviewClient implements ReviewClient {
  readonly kind = 'synthetic' as const;
  private readonly store: ClientStore;
  private readonly timers: Timers;
  private readonly scenario: SyntheticScenario;
  private readonly tickMs: number;
  private tickTimer: number | null = null;
  private sessionStartMs = 0;
  private sessionN = 0;
  private reporter: PlaybackReporter | null = null;
  private segment: Segment | null = null;
  private epoch = 0;
  private eventN = 0;
  private manualN = 0;
  private sensorStep = -1;
  /** Exposed for component tests. */
  readonly feedbackLog: Array<{ bookmarkId: string; action: FeedbackAction; mediaTimeS: number | null }> = [];
  gazeObservationCount = 0;

  constructor(opts: SyntheticClientOptions = {}) {
    this.timers = opts.timers ?? realTimers;
    this.scenario = { ...DEFAULT_SCENARIO, ...opts.scenario };
    this.tickMs = opts.tickMs ?? 250;
    this.store = new ClientStore('synthetic', {
      state: 'idle',
      detail: 'SYNTHETIC adapter (no backend, fake data)',
      backendInstanceId: null,
      backendRestarted: false,
      reconnectAttempt: 0,
    });
  }

  getSnapshot = (): ReviewClientSnapshot => this.store.snapshot;
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  onEvent(listener: (event: ReviewClientEvent) => void): () => void {
    return this.store.onEvent(listener);
  }

  connect(): void {
    if (this.tickTimer !== null) return;
    this.store.setConnection({
      state: 'connected',
      detail: 'SYNTHETIC adapter: no backend; all data is fake',
      backendInstanceId: 'synthetic',
    });
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.tickMs);
  }

  disconnect(): void {
    if (this.tickTimer !== null) this.timers.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.store.setConnection({ state: 'closed', detail: 'SYNTHETIC adapter stopped' });
  }

  dispose(): void {
    this.disconnect();
    this.store.clearListeners();
  }

  /** Test helper: simulate a transient connection loss; the session survives (as a live resume would). */
  simulateConnectionLoss(durationMs: number): void {
    this.store.setConnection({ state: 'reconnecting', detail: 'SYNTHETIC: simulated connection loss', reconnectAttempt: 1 });
    this.timers.setTimeout(() => {
      this.store.setConnection({ state: 'connected', detail: 'SYNTHETIC adapter: resumed', reconnectAttempt: 0 });
    }, durationMs);
  }

  startSession(options: StartSessionOptions): void {
    if (this.store.snapshot.session) this.endSession();
    this.sessionN += 1;
    const sessionId = `syn-ses-${this.sessionN}`;
    const config = checked(
      'session_config',
      {
        sessionId,
        videoId: options.videoId,
        runKind: 'simulated' as const,
        enabledSensors: options.sensors,
        modePolicy: { both: 'automatic', eegOnly: 'automatic', gazeOnly: 'automatic' } as const,
        detector: { detectorId: 'synthetic-adapter', detectorVersion: '0.1.0', configVersion: 'frontend-only' },
        eegDevice: options.sensors.eeg
          ? { model: 'synthetic (not a device)', confirmed: false, sampleRateHz: null, channelNames: null, units: null }
          : null,
        featureSetVersion: null,
        mapping: {
          leadInS: this.scenario.leadInS,
          boundaryMarginMs: 250,
          maxClockUncertaintyMs: 50,
          maxTelemetryStalenessMs: 2500,
          pendingTimeoutMs: 3000,
          maxCandidateAgeMs: 30000,
        },
        createdBackendMs: this.timers.now(),
      },
      sessionId,
    );
    const session: SessionInfo = { sessionId, videoId: options.videoId, runKind: 'simulated', config };
    this.sessionStartMs = this.timers.now();
    this.sensorStep = -1;
    this.segment = null;
    this.store.startSession(session);
    this.reporter = new PlaybackReporter(options.videoId, `syn-${sessionId}`, (s) => this.onPlayback(s));
    this.store.setClock(
      checked(
        'clock_status',
        {
          state: 'synchronised',
          offsetBrowserMinusBackendMs: 0,
          uncertaintyMs: 0,
          bestRttMs: 0,
          sampleCount: 1,
          tBackendMs: this.timers.now(),
        } as const,
        sessionId,
      ),
    );
    this.setEligibility(null);
    this.tick();
  }

  endSession(): void {
    this.reporter = null;
    this.segment = null;
    this.store.endSession('client_ended');
  }

  reportMediaEvent(event: MediaEventName, media: MediaSnapshot): void {
    this.reporter?.handle(event, media, this.timers.now());
  }

  markBookmark(mediaTimeS: number): string {
    const session = this.store.snapshot.session;
    this.manualN += 1;
    const bookmarkId = `syn-manual-${this.manualN}`;
    if (!session) return bookmarkId;
    this.store.upsertBookmark(
      checked<ReviewBookmark>(
        'review_bookmark',
        {
          bookmarkId,
          eventId: null,
          videoId: session.videoId,
          segmentId: null,
          source: 'manual',
          runKind: 'simulated',
          suggestedMediaS: Math.max(0, mediaTimeS),
          evidenceMedia: null,
          evidence: null,
          decisionBackendMs: null,
          mappedBackendMs: this.timers.now(),
          mappingUncertaintyMs: null,
          detector: null,
          contributingSignals: [],
          transcriptContext: null,
        },
        session.sessionId,
      ),
    );
    return bookmarkId;
  }

  sendFeedback(bookmarkId: string, action: FeedbackAction, mediaTimeS: number | null): void {
    this.feedbackLog.push({ bookmarkId, action, mediaTimeS });
  }

  sendGazeObservations(observations: GazeObservation[]): void {
    this.gazeObservationCount += observations.length;
  }

  sendGazeCalibration(_calibration: Omit<GazeCalibration, 'provenance'>): void {
    void _calibration;
  }

  // ---------------------------------------------------------------- simulation

  private onPlayback(state: { state: string; segmentId: string | null; tBrowserMs: number; mediaTimeS: number; playbackRate: number }): void {
    if (state.state === 'playing' && state.segmentId) {
      if (this.segment?.id !== state.segmentId) {
        this.segment = {
          id: state.segmentId,
          startBrowserMs: state.tBrowserMs,
          startMediaS: state.mediaTimeS,
          rate: state.playbackRate,
          lastBookmarkMediaS: state.mediaTimeS,
        };
        this.setEligibility(this.segment);
      }
    } else if (this.segment) {
      this.segment = null;
      this.setEligibility(null, state.state);
    }
  }

  private setEligibility(seg: Segment | null, stateName = 'not_started'): void {
    const session = this.store.snapshot.session;
    if (!session) return;
    this.epoch += 1;
    const reasons: Record<string, string> = {
      paused: 'paused',
      seeking: 'seeking',
      buffering: 'buffering',
      ended: 'ended',
      error: 'error',
      loading: 'not_started',
    };
    this.store.setEligibility(
      checked(
        'playback_eligibility',
        {
          videoId: session.videoId,
          segmentId: seg?.id ?? null,
          eligible: seg !== null,
          reason: (seg ? 'playing' : (reasons[stateName] ?? 'not_started')) as 'playing',
          epoch: this.epoch,
          eligibleSinceBackendMs: seg ? seg.startBrowserMs : null,
          tBackendMs: this.timers.now(),
        },
        session.sessionId,
      ),
    );
  }

  private sensorStatus(step: SyntheticSensorStep): SensorStatus {
    const session = this.store.snapshot.session!;
    const enabled = session.config.enabledSensors;
    const now = this.timers.now();
    const mk = (on: boolean, s: SensorName): SensorState => ({
      state: on ? s : 'disabled',
      reasons: on ? (s === 'ok' ? [] : [step.reason ?? `synthetic: ${s.replace('_', ' ')}`]) : ['not requested'],
      sinceBackendMs: now,
    });
    const eeg = mk(enabled.eeg, step.eeg);
    const gaze = mk(enabled.gaze, step.gaze);
    const eegOk = eeg.state === 'ok';
    const gazeOk = gaze.state === 'ok';
    const mode = eegOk && gazeOk ? 'both' : eegOk ? 'eeg_only' : gazeOk ? 'gaze_only' : 'manual_only';
    return checked(
      'sensor_status',
      {
        eeg,
        gaze,
        mode,
        automaticSuggestions: mode !== 'manual_only',
        automaticReason: mode === 'manual_only' ? 'no sensor is delivering usable data' : `mode ${mode} (synthetic)`,
        tBackendMs: now,
      } as SensorStatus,
      session.sessionId,
    );
  }

  private tick(): void {
    const session = this.store.snapshot.session;
    if (!session) return;
    const now = this.timers.now();
    const elapsedS = (now - this.sessionStartMs) / 1000;
    const steps = this.scenario.sensors;
    let idx = -1;
    for (let i = 0; i < steps.length; i++) if (steps[i]!.atS <= elapsedS) idx = i;
    if (idx !== this.sensorStep && idx >= 0) {
      this.sensorStep = idx;
      this.store.setSensors(this.sensorStatus(steps[idx]!));
    }
    const seg = this.segment;
    const sensors = this.store.snapshot.sensors;
    if (!seg || !sensors?.automaticSuggestions) return;
    const mediaNow = seg.startMediaS + ((now - seg.startBrowserMs) / 1000) * seg.rate;
    const { windowS, bookmarkEveryS, leadInS } = this.scenario;
    if (mediaNow - seg.startMediaS < windowS + 0.2) return; // need a full window inside this segment
    if (mediaNow - seg.lastBookmarkMediaS < bookmarkEveryS) return;
    seg.lastBookmarkMediaS = mediaNow;
    this.eventN += 1;
    const endMedia = mediaNow - 0.2;
    const startMedia = endMedia - windowS;
    const toMs = (m: number) => seg.startBrowserMs + ((m - seg.startMediaS) / seg.rate) * 1000;
    const mode = sensors.mode as 'both' | 'eeg_only' | 'gaze_only';
    const signals = (mode === 'both' ? ['eeg', 'gaze'] : mode === 'eeg_only' ? ['eeg'] : ['gaze']).map((s) => ({
      signal: s as 'eeg' | 'gaze',
      windowIds: [],
      scores: [{ name: 'synthetic', value: null, scale: 'none', missingReason: 'synthetic adapter: no model' }],
    }));
    const eventId = `syn-evt-${this.eventN}`;
    this.store.upsertBookmark(
      checked<ReviewBookmark>(
        'review_bookmark',
        {
          bookmarkId: `bm-${eventId}`,
          eventId,
          videoId: session.videoId,
          segmentId: seg.id,
          source: mode === 'both' ? 'experimental_combined' : mode === 'eeg_only' ? 'experimental_eeg' : 'experimental_gaze',
          runKind: 'simulated',
          suggestedMediaS: Math.max(0, startMedia - leadInS),
          evidenceMedia: { startMediaS: startMedia, endMediaS: endMedia },
          evidence: { startBackendMs: toMs(startMedia), endBackendMs: toMs(endMedia) },
          decisionBackendMs: now,
          mappedBackendMs: now,
          mappingUncertaintyMs: 0,
          detector: { detectorId: 'synthetic-adapter', detectorVersion: '0.1.0', configVersion: 'frontend-only' },
          contributingSignals: signals,
          transcriptContext: null,
        },
        session.sessionId,
      ),
    );
  }
}
