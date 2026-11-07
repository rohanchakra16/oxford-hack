/**
 * PUBLIC INTEGRATION INTERFACE (PROPOSED). Owner: Person 5. Consumer: Person 4 (product UI), Person 2 (gaze).
 *
 * Product code depends only on `ReviewClient` and the types re-exported from `src/integration/index.ts`.
 * Two implementations exist and behave identically from the outside:
 *   - live:      real WebSocket to the local Python backend (createLiveClient)
 *   - synthetic: in-browser, no backend, fake data, always labelled synthetic (createSyntheticClient)
 * See docs/frontend-integration.md. Changes go through a PR labelled `interface-change`.
 */
import type {
  CandidateRejected,
  ClockStatus,
  GazeCalibration,
  GazeObservation,
  PlaybackEligibility,
  ReviewBookmark,
  SensorStatus,
  SessionConfig,
  UserFeedback,
} from '../contracts/generated/types';

export type {
  CandidateRejected,
  ClockStatus,
  ContributingSignal,
  GazeCalibration,
  GazeObservation,
  PlaybackEligibility,
  ReviewBookmark,
  SensorState,
  SensorStatus,
  SessionConfig,
  TranscriptContext,
} from '../contracts/generated/types';

export type FeedbackAction = UserFeedback['action'];
export type RunKind = SessionConfig['runKind'];
export type BookmarkSource = ReviewBookmark['source'];

export type AdapterKind = 'live' | 'synthetic';

export type ConnectionState =
  | 'idle' // not started
  | 'pairing_required' // no launch token: open the pairing link printed by the backend
  | 'connecting'
  | 'connected'
  | 'reconnecting' // transient loss; the session may resume
  | 'incompatible' // schema version mismatch: update frontend or backend
  | 'closed'; // disconnect() was called

export interface ConnectionStatus {
  state: ConnectionState;
  /** Human-readable explanation, safe to show to users. */
  detail: string;
  backendInstanceId: string | null;
  /** True once a backend restart was detected; the old session is gone and a new one is needed. */
  backendRestarted: boolean;
  reconnectAttempt: number;
}

export interface SessionInfo {
  sessionId: string;
  videoId: string;
  runKind: RunKind;
  config: SessionConfig;
}

export interface ClientError {
  /** Contract error code (e.g. invalid_message, obsolete_session) or a client-side code. */
  code: string;
  message: string;
  fatal: boolean;
  source: 'backend' | 'client';
  atBrowserMs: number;
}

/** Everything a UI needs to render. Immutable; a new object on every change (use with useSyncExternalStore). */
export interface ReviewClientSnapshot {
  kind: AdapterKind;
  connection: ConnectionStatus;
  session: SessionInfo | null;
  /** Sensor availability. "unavailable"/"lost" is NOT a possible lapse; bookmarks are separate. */
  sensors: SensorStatus | null;
  eligibility: PlaybackEligibility | null;
  clock: ClockStatus | null;
  /** AUTHORITATIVE bookmark list for the current session, sorted by suggestedMediaS. Do not copy-and-mutate. */
  bookmarks: readonly ReviewBookmark[];
  /** Diagnostics only: candidates the backend refused to map (duplicate, crosses boundary, ...). */
  rejections: readonly CandidateRejected[];
  /** Most recent errors, newest last, at most 50. */
  errors: readonly ClientError[];
}

export interface StartSessionOptions {
  videoId: string;
  /** live = real sensors; simulated = backend synthetic producers. The synthetic adapter forces 'simulated'. */
  runKind: Extract<RunKind, 'live' | 'simulated'>;
  sensors: { eeg: boolean; gaze: boolean };
  mediaDurationS: number | null;
}

/** Media element events the player forwards. Names match HTMLMediaElement events. */
export type MediaEventName =
  | 'loadedmetadata'
  | 'play'
  | 'playing'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'waiting'
  | 'stalled'
  | 'ratechange'
  | 'ended'
  | 'emptied'
  | 'error'
  | 'timeupdate'
  | 'durationchange';

export interface MediaSnapshot {
  /** Explicit PlayerHandle replay, distinct from ordinary lecture playback. */
  replaying?: boolean;
  /** HTMLMediaElement.currentTime */
  currentTime: number;
  playbackRate: number;
  /** HTMLMediaElement.duration (NaN/Infinity allowed: reported as null). */
  duration: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  /** HTMLMediaElement.readyState */
  readyState: number;
}

export type ReviewClientEvent =
  | { type: 'bookmark_added'; bookmark: ReviewBookmark }
  | { type: 'session_started'; session: SessionInfo }
  | { type: 'session_ended'; sessionId: string; reason: string }
  | { type: 'error'; error: ClientError };

export interface ReviewClient {
  readonly kind: AdapterKind;

  /** Current state. Cheap; returns the same object until something changes. */
  getSnapshot(): ReviewClientSnapshot;
  /** Called after every snapshot change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Discrete events (e.g. to show a quiet marker animation). Returns an unsubscribe function. */
  onEvent(listener: (event: ReviewClientEvent) => void): () => void;

  /** Open the connection (live) or start the simulation (synthetic). Idempotent. */
  connect(): void;
  /** Close and stop reconnecting. The client can be connected again later. */
  disconnect(): void;
  /** disconnect() and drop all listeners and timers. Call on unmount. */
  dispose(): void;

  /** One session per video. Ends any current session first. */
  startSession(options: StartSessionOptions): void;
  endSession(reason?: 'user_ended' | 'video_changed' | 'page_closing'): void;

  /**
   * Forward a media element event. The client owns segment ids, telemetry sequencing and
   * 1 s heartbeats while playing; the player only reports what the element did.
   */
  reportMediaEvent(event: MediaEventName, media: MediaSnapshot): void;

  /** Viewer pressed "mark". Returns the new bookmark id; the bookmark arrives via the snapshot. */
  markBookmark(mediaTimeS: number): string;
  /** Replay / dismiss / move earlier / usefulness rating, for evaluation logging. */
  sendFeedback(bookmarkId: string, action: FeedbackAction, mediaTimeS: number | null): void;

  /** Person 2: processed gaze observations (never frames). */
  sendGazeObservations(observations: GazeObservation[]): void;
  sendGazeCalibration(calibration: Omit<GazeCalibration, 'provenance'>): void;
}
