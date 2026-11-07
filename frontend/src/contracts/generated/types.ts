/* GENERATED from contracts/schema/oxford-hack.schema.json by scripts/generate-types.mjs. Do not edit. */

export type WireMessage =
  | ClientHelloMessage
  | ServerHelloMessage
  | HeartbeatMessage
  | ClockPingMessage
  | ClockPongMessage
  | ClockStatusMessage
  | SessionStartMessage
  | SessionEndMessage
  | SessionConfigMessage
  | SessionEndedMessage
  | SessionSnapshotMessage
  | ErrorMessage
  | PlaybackStateMessage
  | PlaybackEligibilityMessage
  | EegFeatureWindowMessage
  | EegStatusMessage
  | GazeObservationBatchMessage
  | GazeCalibrationMessage
  | ReviewCandidateMessage
  | ReviewBookmarkMessage
  | ManualBookmarkMessage
  | CandidateRejectedMessage
  | UserFeedbackMessage
  | SensorStatusMessage;

export interface ClientHelloMessage {
  messageId: string;
  payload: ClientHello;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'client_hello';
}
/**
 * First message on every WebSocket. Browser -> backend. Owner: P5.
 *
 * ``sessionToken`` comes from POST /api/v0/handshake and is bound to ``clientInstanceId``.
 */
export interface ClientHello {
  capabilities: ClientCapabilities;
  /**
   * Random per page load; a reload is a new client.
   */
  clientInstanceId: string;
  resume: ResumeRequest | null;
  sessionToken: string;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserMs: number;
}
export interface ClientCapabilities {
  diagnostics: boolean;
  gaze: boolean;
  playbackTelemetry: boolean;
}
export interface ResumeRequest {
  /**
   * Backend instance the browser last talked to.
   */
  backendInstanceId: string;
  /**
   * Highest server seq the browser processed.
   */
  lastReceivedSeq: number;
  sessionId: string;
}
export interface ServerHelloMessage {
  messageId: string;
  payload: ServerHello;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'server_hello';
}
/**
 * Reply to ClientHello. Backend -> browser. Owner: P5.
 *
 * ``backend_restarted`` means every backend-clock timestamp and segment the browser knew is void:
 * start a new session. ``resumed`` is followed by a SessionSnapshot.
 */
export interface ServerHello {
  backendInstanceId: string;
  connectionId: string;
  /**
   * Duration in milliseconds.
   */
  heartbeatIntervalMs: number;
  /**
   * Duration in milliseconds.
   */
  heartbeatTimeoutMs: number;
  resumeOutcome: 'new' | 'resumed' | 'backend_restarted' | 'session_expired' | 'session_unknown';
  sessionId: string | null;
  /**
   * Backend monotonic milliseconds.
   */
  tBackendMs: number;
}
export interface HeartbeatMessage {
  messageId: string;
  payload: Heartbeat;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'heartbeat';
}
/**
 * Liveness. Either direction. ``clock`` names the sender's clock. Owner: P5.
 */
export interface Heartbeat {
  clock: 'browser' | 'backend';
  sentMs: number;
}
export interface ClockPingMessage {
  messageId: string;
  payload: ClockPing;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'clock_ping';
}
/**
 * Backend -> browser. The browser must answer immediately with ClockPong. Owner: P5.
 */
export interface ClockPing {
  pingId: string;
  /**
   * Backend monotonic milliseconds.
   */
  tBackendSendMs: number;
}
export interface ClockPongMessage {
  messageId: string;
  payload: ClockPong;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'clock_pong';
}
/**
 * Browser -> backend. Echoes the ping and adds browser receive/send times. Owner: P5.
 */
export interface ClockPong {
  pingId: string;
  /**
   * Backend monotonic milliseconds.
   */
  tBackendSendMs: number;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserRecvMs: number;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserSendMs: number;
}
export interface ClockStatusMessage {
  messageId: string;
  payload: ClockStatus;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'clock_status';
}
/**
 * Backend -> browser (diagnostics). Estimate of browser-minus-backend offset. Owner: P5.
 *
 * browserMs = backendMs + offsetBrowserMinusBackendMs (+/- uncertaintyMs).
 */
export interface ClockStatus {
  bestRttMs: number | null;
  offsetBrowserMinusBackendMs: number | null;
  sampleCount: number;
  state: 'unsynchronised' | 'synchronised' | 'degraded';
  /**
   * Backend monotonic milliseconds.
   */
  tBackendMs: number;
  uncertaintyMs: number | null;
}
export interface SessionStartMessage {
  messageId: string;
  payload: SessionStart;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'session_start';
}
/**
 * Browser -> backend: start a session for one video. Owner: P5 (sent by P4's player).
 *
 * One session = one video. To change video, send SessionEnd then a new SessionStart.
 */
export interface SessionStart {
  mediaDurationS: number | null;
  requestedSensors: RequestedSensors;
  runKind: 'live' | 'replay' | 'simulated';
  videoId: string;
}
export interface RequestedSensors {
  eeg: boolean;
  gaze: boolean;
}
export interface SessionEndMessage {
  messageId: string;
  payload: SessionEnd;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'session_end';
}
/**
 * Browser -> backend. Owner: P5.
 */
export interface SessionEnd {
  reason: 'user_ended' | 'video_changed' | 'page_closing';
}
export interface SessionConfigMessage {
  messageId: string;
  payload: SessionConfig;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'session_config';
}
/**
 * Backend -> browser: authoritative session configuration. Owner: P5.
 */
export interface SessionConfig {
  /**
   * Backend monotonic milliseconds.
   */
  createdBackendMs: number;
  detector: DetectorInfo | null;
  eegDevice: EegDeviceInfo | null;
  enabledSensors: RequestedSensors;
  featureSetVersion: string | null;
  mapping: MappingConfig;
  modePolicy: ModePolicy;
  runKind: 'live' | 'replay' | 'simulated';
  sessionId: string;
  videoId: string;
}
/**
 * Identity of the experimental detector (P3's model bundle).
 */
export interface DetectorInfo {
  configVersion: string;
  detectorId: string;
  detectorVersion: string;
}
/**
 * Device metadata as reported by P1's adapter. Unconfirmed values stay null.
 */
export interface EegDeviceInfo {
  channelNames: string[] | null;
  /**
   * True only once P1 has verified this against the device.
   */
  confirmed: boolean;
  model: string | null;
  sampleRateHz: number | null;
  units: string | null;
}
export interface MappingConfig {
  /**
   * Duration in milliseconds.
   */
  boundaryMarginMs: number;
  leadInS: number;
  /**
   * Duration in milliseconds.
   */
  maxCandidateAgeMs: number;
  /**
   * Duration in milliseconds.
   */
  maxClockUncertaintyMs: number;
  /**
   * Duration in milliseconds.
   */
  maxTelemetryStalenessMs: number;
  /**
   * Duration in milliseconds.
   */
  pendingTimeoutMs: number;
}
/**
 * Which operating modes may produce automatic suggestions.
 *
 * A mode is ``automatic`` if evaluated, simulated, or explicitly enabled by the local operator
 * for an experimental live detector. Experimental opt-in is not evaluation evidence and is
 * reported in sensor-status reasons and detector identity. Otherwise the mode is manual-only.
 */
export interface ModePolicy {
  both: 'automatic' | 'manual_only';
  eegOnly: 'automatic' | 'manual_only';
  gazeOnly: 'automatic' | 'manual_only';
}
export interface SessionEndedMessage {
  messageId: string;
  payload: SessionEnded;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'session_ended';
}
/**
 * Backend -> browser. Owner: P5.
 */
export interface SessionEnded {
  reason: 'client_ended' | 'expired' | 'superseded' | 'backend_shutdown';
}
export interface SessionSnapshotMessage {
  messageId: string;
  payload: SessionSnapshot;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'session_snapshot';
}
/**
 * Backend -> browser after a successful resume. Replaces any client-side session state.
 */
export interface SessionSnapshot {
  bookmarks: ReviewBookmark[];
  config: SessionConfig;
  lastSeq: number;
  sensorStatus: SensorStatus;
}
/**
 * Backend -> browser. A candidate mapped to media time by P5, or a manual bookmark. Owner: P5.
 *
 * ``suggestedMediaS`` is a conservative restart suggestion derived from the evidence interval,
 * not a measured lapse onset. ``bookmarkId`` is stable per event, so clients can de-duplicate.
 */
export interface ReviewBookmark {
  bookmarkId: string;
  contributingSignals: ContributingSignal[];
  decisionBackendMs: number | null;
  detector: DetectorInfo | null;
  eventId: string | null;
  evidence: BackendInterval | null;
  evidenceMedia: MediaInterval | null;
  /**
   * Backend monotonic milliseconds.
   */
  mappedBackendMs: number;
  mappingUncertaintyMs: number | null;
  runKind: 'live' | 'replay' | 'simulated';
  segmentId: string | null;
  source: 'experimental_eeg' | 'experimental_gaze' | 'experimental_combined' | 'manual';
  /**
   * Media playback position in seconds.
   */
  suggestedMediaS: number;
  transcriptContext: TranscriptContext | null;
  videoId: string;
}
export interface ContributingSignal {
  scores: SignalScore[];
  signal: 'eeg' | 'gaze';
  windowIds: string[];
}
/**
 * A named score from one signal. Scores from different sources are not interchangeable.
 */
export interface SignalScore {
  missingReason: string | null;
  name: string;
  /**
   * e.g. 'logit', 'uncalibrated_probability', 'fraction_of_window'.
   */
  scale: string;
  value: number | null;
}
/**
 * Closed interval on the backend clock. ``end >= start``.
 */
export interface BackendInterval {
  /**
   * Backend monotonic milliseconds.
   */
  endBackendMs: number;
  /**
   * Backend monotonic milliseconds.
   */
  startBackendMs: number;
}
/**
 * Closed interval in media seconds. ``end >= start``.
 */
export interface MediaInterval {
  /**
   * Media playback position in seconds.
   */
  endMediaS: number;
  /**
   * Media playback position in seconds.
   */
  startMediaS: number;
}
/**
 * Filled by the browser (P4) from its transcript; the backend always sends null.
 */
export interface TranscriptContext {
  /**
   * Media playback position in seconds.
   */
  endMediaS: number;
  /**
   * Media playback position in seconds.
   */
  startMediaS: number;
  text: string;
}
/**
 * Backend -> browser and inference. Sent on change. Owner: P5.
 */
export interface SensorStatus {
  automaticReason: string;
  automaticSuggestions: boolean;
  eeg: SensorState;
  gaze: SensorState;
  mode: 'both' | 'eeg_only' | 'gaze_only' | 'manual_only';
  /**
   * Backend monotonic milliseconds.
   */
  tBackendMs: number;
}
export interface SensorState {
  reasons: string[];
  /**
   * Backend monotonic milliseconds.
   */
  sinceBackendMs: number;
  state: 'disabled' | 'unavailable' | 'connecting' | 'warming_up' | 'ok' | 'degraded' | 'lost';
}
export interface ErrorMessage {
  messageId: string;
  payload: ErrorReport;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'error';
}
/**
 * Either direction. Never contains signal values. Owner: P5.
 */
export interface ErrorReport {
  code:
    | 'invalid_json'
    | 'invalid_message'
    | 'schema_version_mismatch'
    | 'unknown_type'
    | 'unexpected_type'
    | 'message_too_large'
    | 'not_authenticated'
    | 'no_session'
    | 'obsolete_session'
    | 'video_mismatch'
    | 'out_of_order'
    | 'duplicate'
    | 'stale'
    | 'rate_limited'
    | 'backpressure'
    | 'internal';
  details: {
    [k: string]: (string | number | boolean | null) | undefined;
  };
  fatal: boolean;
  message: string;
  refMessageId: string | null;
}
export interface PlaybackStateMessage {
  messageId: string;
  payload: PlaybackState;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'playback_state';
}
/**
 * Browser -> backend. Sent on every media event and every ~1 s while playing. Owner: P4 (P5 contract).
 *
 * ``segmentId`` is non-null exactly when ``state == "playing"``. A new segment id starts whenever
 * frames start advancing after any interruption (pause, seek, buffering, rate change, source change).
 * Within one segment ``playbackRate`` is constant. ``tBrowserMs`` is when the media element event
 * was observed, not when the message was sent.
 */
export interface PlaybackState {
  event:
    | 'load'
    | 'playing'
    | 'pause'
    | 'seeking'
    | 'seeked'
    | 'waiting'
    | 'ratechange'
    | 'source_change'
    | 'ended'
    | 'heartbeat'
    | 'error';
  mediaDurationS: number | null;
  /**
   * Media playback position in seconds.
   */
  mediaTimeS: number;
  playbackRate: number;
  /**
   * Explicit review replay; never eligible for new reminders.
   */
  replaying?: boolean;
  segmentId: string | null;
  state: 'loading' | 'playing' | 'paused' | 'seeking' | 'buffering' | 'ended' | 'error';
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserMs: number;
  /**
   * Monotonic per video within a page load.
   */
  telemetrySeq: number;
  videoId: string;
}
export interface PlaybackEligibilityMessage {
  messageId: string;
  payload: PlaybackEligibility;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'playback_eligibility';
}
/**
 * Backend -> inference (P3) and browser (diagnostics). Owner: P5.
 *
 * When ``eligible`` becomes false or ``segmentId`` changes, the detector must clear pending
 * decisions and wait for a complete evidence window starting at or after ``eligibleSinceBackendMs``.
 * This does NOT mean EEG filters should be reset (P1 keeps filter state continuous).
 * ``epoch`` increases by one on every change.
 */
export interface PlaybackEligibility {
  eligible: boolean;
  eligibleSinceBackendMs: number | null;
  epoch: number;
  reason:
    | 'playing'
    | 'not_started'
    | 'paused'
    | 'seeking'
    | 'buffering'
    | 'ended'
    | 'source_change'
    | 'error'
    | 'stale_telemetry'
    | 'clock_unsynchronised'
    | 'session_ended'
    | 'review_replay';
  segmentId: string | null;
  /**
   * Backend monotonic milliseconds.
   */
  tBackendMs: number;
  videoId: string;
}
export interface EegFeatureWindowMessage {
  messageId: string;
  payload: EegFeatureWindow;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'eeg_features';
}
/**
 * P1 -> backend hub -> P3. One complete, continuous window of features.
 *
 * ``evidence`` is the acquisition interval converted to backend time. ``deviceEvidence`` keeps the
 * original device timestamps. ``tProcessedBackendMs`` is when features became available.
 */
export interface EegFeatureWindow {
  channels: string[];
  clockCorrection: ClockCorrection;
  deviceEvidenceEndDeviceS: number | null;
  deviceEvidenceStartDeviceS: number | null;
  evidence: BackendInterval;
  featureSetVersion: string;
  features: EegFeature[];
  provenance: Provenance;
  quality: EegWindowQuality;
  samples: SampleCounts;
  streamId: string;
  /**
   * Backend monotonic milliseconds.
   */
  tProcessedBackendMs: number;
  windowId: string;
}
/**
 * How device time was converted to backend time (P1 applies it; P5 provides mappers).
 */
export interface ClockCorrection {
  driftPpm: number | null;
  method: 'lsl_time_correction' | 'linear_fit' | 'same_clock' | 'fixed_offset';
  offsetS: number | null;
  uncertaintyMs: number | null;
}
/**
 * One feature value. ``value`` null requires ``missingReason``; a valid zero is a real zero.
 */
export interface EegFeature {
  channel: string | null;
  missingReason: string | null;
  name: string;
  unit: string;
  value: number | null;
}
/**
 * Who produced a message and in what kind of run.
 */
export interface Provenance {
  /**
   * Component name, e.g. 'synthetic-eeg' or 'unicorn-lsl-adapter'.
   */
  producer: string;
  producerVersion: string;
  runKind: 'live' | 'replay' | 'simulated';
}
/**
 * Quality checks reduce contamination; they do not prove remaining activity is neural.
 */
export interface EegWindowQuality {
  channels: EegChannelQuality[];
  flags: (
    | 'disconnected'
    | 'flatline'
    | 'clipping'
    | 'missing_samples'
    | 'poor_contact'
    | 'large_artifact'
    | 'settling'
    | 'gap_recovery'
    | 'units_unverified'
    | 'clock_uncertain'
  )[];
  usable: boolean;
}
export interface EegChannelQuality {
  channel: string;
  flags: (
    | 'disconnected'
    | 'flatline'
    | 'clipping'
    | 'missing_samples'
    | 'poor_contact'
    | 'large_artifact'
    | 'settling'
    | 'gap_recovery'
    | 'units_unverified'
    | 'clock_uncertain'
  )[];
  state: 'good' | 'poor' | 'bad' | 'unknown';
}
export interface SampleCounts {
  expected: number;
  received: number;
}
export interface EegStatusMessage {
  messageId: string;
  payload: EegStatus;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'eeg_status';
}
/**
 * P1 -> backend hub. Stream-level status, sent on change and at least every 5 s.
 */
export interface EegStatus {
  device: EegDeviceInfo;
  droppedPackets: number | null;
  flags: (
    | 'disconnected'
    | 'flatline'
    | 'clipping'
    | 'missing_samples'
    | 'poor_contact'
    | 'large_artifact'
    | 'settling'
    | 'gap_recovery'
    | 'units_unverified'
    | 'clock_uncertain'
  )[];
  provenance: Provenance;
  state: 'disabled' | 'unavailable' | 'connecting' | 'warming_up' | 'ok' | 'degraded' | 'lost';
  streamId: string;
  /**
   * Backend monotonic milliseconds.
   */
  tBackendMs: number;
}
export interface GazeObservationBatchMessage {
  messageId: string;
  payload: GazeObservationBatch;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'gaze_observations';
}
/**
 * Browser -> backend, at most ~10 batches/s. Owner: P2.
 */
export interface GazeObservationBatch {
  /**
   * @minItems 1
   * @maxItems 64
   */
  observations: [GazeObservation, ...GazeObservation[]];
  provenance: Provenance;
}
/**
 * One processed webcam frame. ``tBrowserFrameMs`` is when the frame was captured/observed.
 *
 * ``measurementKind`` must say ``head_direction`` if the model does not estimate screen gaze.
 * ``insideVideo`` false is a valid observation ("looking outside video"), distinct from invalid.
 */
export interface GazeObservation {
  calibrationId: string | null;
  insideVideo: boolean | null;
  invalidReasons: (
    | 'face_not_detected'
    | 'eyes_not_detected'
    | 'calibration_missing'
    | 'calibration_invalid'
    | 'low_confidence'
    | 'camera_unavailable'
    | 'video_not_visible'
    | 'tab_hidden'
    | 'frame_dropped'
  )[];
  measurementKind: 'screen_gaze' | 'head_direction';
  /**
   * Model-specific; not comparable with other models or with EEG scores.
   */
  modelConfidence: number | null;
  observationId: string;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserFrameMs: number;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserProcessedMs: number;
  valid: boolean;
  videoPoint: NormalisedPoint | null;
}
/**
 * Point in the displayed video content rectangle. (0,0)=top-left, (1,1)=bottom-right.
 *
 * Values outside [0,1] are allowed and mean the estimate is outside the video.
 */
export interface NormalisedPoint {
  x: number;
  y: number;
}
export interface GazeCalibrationMessage {
  messageId: string;
  payload: GazeCalibration;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'gaze_calibration';
}
/**
 * Browser -> backend, on every calibration state change. Owner: P2.
 *
 * Accuracy is measured on held-out points excluded from fitting.
 */
export interface GazeCalibration {
  calibrationId: string;
  fitPoints: number;
  /**
   * Mean held-out error as a fraction of video width.
   */
  heldOutErrorNorm: number | null;
  heldOutPoints: number;
  invalidatedReason: string | null;
  measurementKind: 'screen_gaze' | 'head_direction';
  method: string;
  provenance: Provenance;
  status: 'in_progress' | 'valid' | 'invalid' | 'expired';
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserMs: number;
  videoRectCssPx: CssRect;
  viewportCssPx: CssRect;
}
export interface CssRect {
  height: number;
  width: number;
  x: number;
  y: number;
}
export interface ReviewCandidateMessage {
  messageId: string;
  payload: ReviewCandidate;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'review_candidate';
}
/**
 * P3 detector -> P5 hub. Backend clock only: the detector never needs media time.
 *
 * ``evidence`` is the interval the decision is based on. ``decisionBackendMs`` is when it was made.
 * ``eventId`` must be stable: re-sending the same event must reuse it (duplicates are dropped).
 * ``eligibilityEpoch`` is the latest PlaybackEligibility.epoch the detector saw (diagnostic only).
 */
export interface ReviewCandidate {
  /**
   * @minItems 1
   */
  contributingSignals: [ContributingSignal, ...ContributingSignal[]];
  /**
   * Backend monotonic milliseconds.
   */
  decisionBackendMs: number;
  detector: DetectorInfo;
  eligibilityEpoch: number | null;
  eventId: string;
  evidence: BackendInterval;
  mode: 'both' | 'eeg_only' | 'gaze_only';
  provenance: Provenance;
}
export interface ReviewBookmarkMessage {
  messageId: string;
  payload: ReviewBookmark;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'review_bookmark';
}
export interface ManualBookmarkMessage {
  messageId: string;
  payload: ManualBookmark;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'manual_bookmark';
}
/**
 * Browser -> backend: the viewer pressed 'mark'. Owner: P4.
 */
export interface ManualBookmark {
  bookmarkId: string;
  /**
   * Media playback position in seconds.
   */
  mediaTimeS: number;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserMs: number;
  videoId: string;
}
export interface CandidateRejectedMessage {
  messageId: string;
  payload: CandidateRejected;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'candidate_rejected';
}
/**
 * Backend -> browser (diagnostics only). Owner: P5.
 */
export interface CandidateRejected {
  detail: string;
  eventId: string | null;
  reason:
    | 'duplicate'
    | 'obsolete_session'
    | 'mode_not_automatic'
    | 'too_old'
    | 'clock_unsynchronised'
    | 'clock_uncertain'
    | 'not_playing'
    | 'crosses_boundary'
    | 'history_expired'
    | 'stale_telemetry'
    | 'video_mismatch'
    | 'out_of_media_bounds'
    | 'invalid';
}
export interface UserFeedbackMessage {
  messageId: string;
  payload: UserFeedback;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'user_feedback';
}
/**
 * Browser -> backend. Owner: P4. Logged for evaluation (P3).
 */
export interface UserFeedback {
  action: 'replay' | 'dismiss' | 'move_earlier' | 'rated_useful' | 'rated_not_useful';
  bookmarkId: string;
  feedbackId: string;
  mediaTimeS: number | null;
  /**
   * Browser performance.now() milliseconds.
   */
  tBrowserMs: number;
}
export interface SensorStatusMessage {
  messageId: string;
  payload: SensorStatus;
  schemaVersion: '0.1.0';
  seq: number;
  sessionId: string | null;
  type: 'sensor_status';
}

export const SCHEMA_VERSION = "0.1.0";
export const MESSAGE_TYPES = ["candidate_rejected","client_hello","clock_ping","clock_pong","clock_status","eeg_features","eeg_status","error","gaze_calibration","gaze_observations","heartbeat","manual_bookmark","playback_eligibility","playback_state","review_bookmark","review_candidate","sensor_status","server_hello","session_config","session_end","session_ended","session_snapshot","session_start","user_feedback"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
