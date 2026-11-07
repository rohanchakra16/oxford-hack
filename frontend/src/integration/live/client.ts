/**
 * Live adapter: the only WebSocket client in the frontend. Owner: Person 5.
 *
 * Lifecycle (docs/frontend-integration.md#lifecycle):
 *   connect() -> handshake (launch token -> single-use session token) -> WebSocket -> client_hello
 *   -> server_hello: resumed (+ session_snapshot) | new | backend_restarted | session_expired | session_unknown
 * On transport loss: reconnect with capped exponential backoff, re-handshake, try to resume.
 * If the backend restarted, the old session is void: start a new one for the same video automatically.
 */
import { SCHEMA_VERSION, type WireMessage } from '../../contracts/generated/types';
import { ContractValidationError, parseMessage } from '../../contracts/validate';
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
  StartSessionOptions,
} from '../types';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LiveClientOptions {
  /** e.g. http://127.0.0.1:8765 */
  backendUrl: string;
  /** Launch token from the pairing link (see pairing.ts). null => pairing_required. */
  getLaunchToken: () => string | null;
  timers?: Timers;
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => WebSocketLike;
  /** Random per page load unless provided (tests). */
  clientInstanceId?: string;
  maxReconnectAttempts?: number;
  /** Queue limit for bookmarks/feedback while disconnected. */
  maxQueued?: number;
}

const OPEN = 1;
const QUEUEABLE = new Set(['manual_bookmark', 'user_feedback']);
const SESSION_SCOPED = new Set([
  'session_end',
  'playback_state',
  'gaze_observations',
  'gaze_calibration',
  'manual_bookmark',
  'user_feedback',
]);

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class LiveReviewClient implements ReviewClient {
  readonly kind = 'live' as const;
  private readonly store: ClientStore;
  private readonly timers: Timers;
  private readonly fetchFn: typeof fetch;
  private readonly createWs: (url: string) => WebSocketLike;
  readonly clientInstanceId: string;
  private ws: WebSocketLike | null = null;
  private wanted = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private outSeq = 0;
  private lastInboundMs = 0;
  private heartbeatIntervalMs = 2000;
  private heartbeatTimeoutMs = 6000;
  private backendInstanceId: string | null = null;
  private sessionOptions: StartSessionOptions | null = null;
  private pendingStart = false;
  private lastSessionSeq = -1;
  private queued: Array<{ type: string; payload: unknown }> = [];
  private reporter: PlaybackReporter | null = null;
  private lastMedia: { event: MediaEventName; media: MediaSnapshot } | null = null;
  private manualN = 0;
  private generation = 0;

  constructor(private readonly opts: LiveClientOptions) {
    this.timers = opts.timers ?? realTimers;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.createWs = opts.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.clientInstanceId = opts.clientInstanceId ?? randomId('client');
    this.store = new ClientStore('live', {
      state: 'idle',
      detail: 'not connected',
      backendInstanceId: null,
      backendRestarted: false,
      reconnectAttempt: 0,
    });
  }

  // ---------------------------------------------------------------- ReviewClient: state

  getSnapshot = (): ReviewClientSnapshot => this.store.snapshot;
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  onEvent(listener: (event: ReviewClientEvent) => void): () => void {
    return this.store.onEvent(listener);
  }

  // ---------------------------------------------------------------- ReviewClient: lifecycle

  connect(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    void this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.generation += 1;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'client disconnect');
    this.store.setConnection({ state: 'closed', detail: 'disconnected by the app' });
  }

  dispose(): void {
    this.disconnect();
    this.store.clearListeners();
  }

  startSession(options: StartSessionOptions): void {
    if (this.store.snapshot.session) this.endSession('video_changed');
    this.sessionOptions = options;
    this.reporter = null;
    this.sendSessionStart();
  }

  endSession(reason: 'user_ended' | 'video_changed' | 'page_closing' = 'user_ended'): void {
    if (this.store.snapshot.session) this.send('session_end', { reason });
    this.sessionOptions = null;
    this.reporter = null;
    this.pendingStart = false;
    this.store.endSession('client_ended');
  }

  // ---------------------------------------------------------------- ReviewClient: actions

  reportMediaEvent(event: MediaEventName, media: MediaSnapshot): void {
    this.lastMedia = { event, media };
    this.reporter?.handle(event, media, this.timers.now());
  }

  markBookmark(mediaTimeS: number): string {
    const session = this.store.snapshot.session;
    this.manualN += 1;
    const bookmarkId = `manual-${this.clientInstanceId}-${this.manualN}`;
    if (session) {
      this.send('manual_bookmark', {
        bookmarkId,
        videoId: session.videoId,
        mediaTimeS: Math.max(0, mediaTimeS),
        tBrowserMs: this.timers.now(),
      });
    }
    return bookmarkId;
  }

  sendFeedback(bookmarkId: string, action: FeedbackAction, mediaTimeS: number | null): void {
    this.send('user_feedback', {
      feedbackId: randomId('fb'),
      bookmarkId,
      action,
      tBrowserMs: this.timers.now(),
      mediaTimeS,
    });
  }

  sendGazeObservations(observations: GazeObservation[]): void {
    const runKind = this.store.snapshot.session?.runKind;
    if (!runKind || observations.length === 0) return;
    for (let i = 0; i < observations.length; i += 64) {
      this.send('gaze_observations', {
        observations: observations.slice(i, i + 64),
        provenance: { runKind, producer: 'browser-gaze', producerVersion: '0.1.0' },
      });
    }
  }

  sendGazeCalibration(calibration: Omit<GazeCalibration, 'provenance'>): void {
    const runKind = this.store.snapshot.session?.runKind;
    if (!runKind) return;
    this.send('gaze_calibration', {
      ...calibration,
      provenance: { runKind, producer: 'browser-gaze', producerVersion: '0.1.0' },
    });
  }

  // ---------------------------------------------------------------- connection internals

  private wsUrl(): string {
    const u = new URL('/ws/v0', this.opts.backendUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  private async open(): Promise<void> {
    const gen = ++this.generation;
    const token = this.opts.getLaunchToken();
    if (!token) {
      this.store.setConnection({
        state: 'pairing_required',
        detail: 'Open the pairing link printed by the backend (npm run dev) to connect.',
      });
      this.wanted = false;
      return;
    }
    this.store.setConnection({
      state: this.attempt === 0 ? 'connecting' : 'reconnecting',
      detail: this.attempt === 0 ? 'contacting local backend' : `reconnecting (attempt ${this.attempt})`,
      reconnectAttempt: this.attempt,
    });
    let sessionToken: string;
    try {
      const res = await this.fetchFn(new URL('/api/v0/handshake', this.opts.backendUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchToken: token, clientInstanceId: this.clientInstanceId }),
      });
      if (gen !== this.generation) return;
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const message = typeof body.message === 'string' ? body.message : `handshake failed (${res.status})`;
        if (res.status === 401 || res.status === 403) {
          this.wanted = false;
          this.store.setConnection({ state: 'pairing_required', detail: message });
          this.recordError(String(body.error ?? 'not_authenticated'), message, true);
          return;
        }
        throw new Error(message);
      }
      if (body.schemaVersion !== SCHEMA_VERSION) {
        this.wanted = false;
        this.store.setConnection({
          state: 'incompatible',
          detail: `backend speaks schema ${String(body.schemaVersion)}, this page ${SCHEMA_VERSION}`,
        });
        return;
      }
      sessionToken = String(body.sessionToken);
      const instance = String(body.backendInstanceId);
      if (this.backendInstanceId && instance !== this.backendInstanceId) {
        this.onBackendRestarted(instance);
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.scheduleReconnect(err instanceof Error ? err.message : 'backend unreachable');
      return;
    }

    const ws = this.createWs(this.wsUrl());
    this.ws = ws;
    this.outSeq = 0;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      const session = this.store.snapshot.session;
      this.lastInboundMs = this.timers.now();
      this.rawSend('client_hello', null, {
        clientInstanceId: this.clientInstanceId,
        sessionToken,
        resume:
          session && this.backendInstanceId
            ? {
                sessionId: session.sessionId,
                backendInstanceId: this.backendInstanceId,
                lastReceivedSeq: Math.max(0, this.lastSessionSeq),
              }
            : null,
        capabilities: { playbackTelemetry: true, gaze: true, diagnostics: true },
        tBrowserMs: this.timers.now(),
      });
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      this.lastInboundMs = this.timers.now();
      this.onText(typeof ev.data === 'string' ? ev.data : '');
    };
    ws.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.ws = null;
      this.clearTimers();
      if (ev.code === 4401 || ev.code === 4403) {
        this.wanted = false;
        this.store.setConnection({ state: 'pairing_required', detail: `backend refused the connection (${ev.reason})` });
        return;
      }
      if (ev.code === 4400 && ev.reason === 'schema_version_mismatch') {
        this.wanted = false;
        this.store.setConnection({ state: 'incompatible', detail: 'schema version mismatch with backend' });
        return;
      }
      this.scheduleReconnect(ev.reason || `connection closed (${ev.code})`);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(detail: string): void {
    if (!this.wanted) return;
    const max = this.opts.maxReconnectAttempts ?? 120;
    if (this.attempt >= max) {
      this.wanted = false;
      this.store.setConnection({ state: 'closed', detail: `gave up after ${max} attempts: ${detail}` });
      return;
    }
    this.attempt += 1;
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.attempt - 1, 5));
    this.store.setConnection({ state: 'reconnecting', detail, reconnectAttempt: this.attempt });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = this.timers.setInterval(() => {
      if (this.timers.now() - this.lastInboundMs > this.heartbeatTimeoutMs) {
        this.recordError('heartbeat_timeout', 'no message from backend within heartbeat timeout', false);
        this.ws?.close(4000, 'heartbeat timeout');
        return;
      }
      this.rawSend('heartbeat', this.currentSessionIdForSend(), { clock: 'browser', sentMs: this.timers.now() });
    }, this.heartbeatIntervalMs);
  }

  private onBackendRestarted(instance: string): void {
    this.backendInstanceId = instance;
    const hadSession = this.store.snapshot.session !== null;
    this.store.setConnection({ backendRestarted: true });
    if (hadSession) {
      this.store.endSession('backend_restarted');
      this.recordError('backend_restarted', 'the backend restarted; previous session and its bookmarks were lost', false);
    }
    this.reporter = null;
  }

  // ---------------------------------------------------------------- inbound

  private onText(text: string): void {
    let msg: WireMessage;
    try {
      msg = parseMessage(text);
    } catch (err) {
      const e = err instanceof ContractValidationError ? err : new ContractValidationError('invalid_message', String(err));
      // Reject the message, keep the connection.
      this.recordError(e.code, `rejected message from backend: ${e.message}`, false);
      return;
    }
    const session = this.store.snapshot.session;
    if (msg.sessionId !== null && session && msg.sessionId === session.sessionId && msg.type !== 'session_snapshot') {
      if (msg.seq <= this.lastSessionSeq) return; // duplicate/out-of-order delivery
      this.lastSessionSeq = msg.seq;
    }
    if (msg.sessionId !== null && msg.type !== 'session_config' && msg.type !== 'session_snapshot') {
      if (!session || msg.sessionId !== session.sessionId) return; // obsolete session
    }
    switch (msg.type) {
      case 'server_hello': {
        const p = msg.payload;
        if (this.backendInstanceId && p.backendInstanceId !== this.backendInstanceId) this.onBackendRestarted(p.backendInstanceId);
        this.backendInstanceId = p.backendInstanceId;
        this.heartbeatIntervalMs = p.heartbeatIntervalMs;
        this.heartbeatTimeoutMs = p.heartbeatTimeoutMs;
        this.attempt = 0;
        this.store.setConnection({
          state: 'connected',
          detail: `connected (${p.resumeOutcome.replace('_', ' ')})`,
          backendInstanceId: p.backendInstanceId,
          reconnectAttempt: 0,
        });
        this.startHeartbeat();
        if (p.resumeOutcome !== 'resumed') {
          if (this.store.snapshot.session) this.store.endSession(p.resumeOutcome);
          if (this.sessionOptions) this.sendSessionStart();
        }
        return;
      }
      case 'session_config': {
        const c = msg.payload;
        if (!this.pendingStart || !this.sessionOptions || c.videoId !== this.sessionOptions.videoId) return;
        this.pendingStart = false;
        this.lastSessionSeq = msg.seq;
        this.store.startSession({ sessionId: c.sessionId, videoId: c.videoId, runKind: c.runKind, config: c });
        this.reporter = new PlaybackReporter(c.videoId, `${this.clientInstanceId}-${c.sessionId}`, (state) =>
          this.send('playback_state', state),
        );
        this.replayLastMedia();
        this.flushQueue();
        return;
      }
      case 'session_snapshot': {
        const s = msg.payload;
        if (!session || s.config.sessionId !== session.sessionId) return;
        this.lastSessionSeq = msg.seq;
        this.store.restoreSession(
          { sessionId: s.config.sessionId, videoId: s.config.videoId, runKind: s.config.runKind, config: s.config },
          s.bookmarks,
          s.sensorStatus,
        );
        this.reporter?.resync(this.timers.now());
        this.flushQueue();
        return;
      }
      case 'session_ended':
        this.store.endSession(msg.payload.reason);
        this.reporter = null;
        return;
      case 'review_bookmark':
        this.store.upsertBookmark(msg.payload);
        return;
      case 'sensor_status':
        this.store.setSensors(msg.payload);
        return;
      case 'playback_eligibility':
        this.store.setEligibility(msg.payload);
        return;
      case 'clock_status':
        this.store.setClock(msg.payload);
        return;
      case 'candidate_rejected':
        this.store.addRejection(msg.payload);
        return;
      case 'clock_ping': {
        const recv = this.timers.now();
        this.rawSend('clock_pong', this.currentSessionIdForSend(), {
          pingId: msg.payload.pingId,
          tBackendSendMs: msg.payload.tBackendSendMs,
          tBrowserRecvMs: recv,
          tBrowserSendMs: this.timers.now(),
        });
        return;
      }
      case 'error': {
        const e = msg.payload;
        this.recordError(e.code, e.message, e.fatal, 'backend');
        if (e.code === 'schema_version_mismatch') {
          this.wanted = false;
          this.store.setConnection({ state: 'incompatible', detail: e.message });
        }
        return;
      }
      case 'heartbeat':
        return;
      default:
        this.recordError('unexpected_type', `backend sent ${msg.type}, which the browser does not accept`, false);
    }
  }

  private replayLastMedia(): void {
    const last = this.lastMedia;
    if (!last || !this.reporter) return;
    this.reporter.handle('loadedmetadata', last.media, this.timers.now());
    if (!last.media.paused && !last.media.seeking) this.reporter.handle('playing', last.media, this.timers.now());
  }

  // ---------------------------------------------------------------- outbound

  private currentSessionIdForSend(): string | null {
    return this.store.snapshot.session?.sessionId ?? null;
  }

  private sendSessionStart(): void {
    const o = this.sessionOptions;
    if (!o) return;
    this.pendingStart = true;
    this.rawSend('session_start', null, {
      videoId: o.videoId,
      runKind: o.runKind,
      requestedSensors: o.sensors,
      mediaDurationS: o.mediaDurationS,
    });
  }

  private send(type: string, payload: unknown): void {
    const sessionId = this.currentSessionIdForSend();
    if (SESSION_SCOPED.has(type) && !sessionId) {
      if (QUEUEABLE.has(type)) this.enqueue(type, payload);
      return;
    }
    if (!this.ws || this.ws.readyState !== OPEN || this.store.snapshot.connection.state !== 'connected') {
      if (QUEUEABLE.has(type)) this.enqueue(type, payload);
      return; // telemetry/gaze while disconnected is dropped; resync() starts a fresh segment
    }
    this.rawSend(type, sessionId, payload);
  }

  private enqueue(type: string, payload: unknown): void {
    const max = this.opts.maxQueued ?? 100;
    this.queued.push({ type, payload });
    if (this.queued.length > max) {
      this.queued.shift();
      this.recordError('queue_overflow', 'dropped the oldest queued bookmark/feedback while disconnected', false);
    }
  }

  private flushQueue(): void {
    const q = this.queued;
    this.queued = [];
    for (const item of q) this.send(item.type, item.payload);
  }

  private rawSend(type: string, sessionId: string | null, payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    const msg = {
      schemaVersion: SCHEMA_VERSION,
      messageId: randomId('m'),
      sessionId,
      seq: this.outSeq++,
      type,
      payload,
    };
    ws.send(JSON.stringify(msg));
  }

  private recordError(code: string, message: string, fatal: boolean, source: 'backend' | 'client' = 'client'): void {
    this.store.addError({ code, message, fatal, source, atBrowserMs: this.timers.now() });
  }

  /** Diagnostics only: send arbitrary text through the real socket (used to prove rejection paths). */
  sendRawForDiagnostics(text: string): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(text);
    return true;
  }
}
