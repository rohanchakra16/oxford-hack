import type { PlaybackStatus, PlayerHandle } from '../../frontend/src/player';
import type { GazeWindow } from './gaze';

export interface Segment {
  segmentId: string;
  mediaRange: { startMediaS: number; endMediaS: number };
  closed: boolean;
}
export interface EvaluationSnapshot {
  sessionId: string;
  videoId: string;
  prototype: true;
  source: 'synthetic' | 'eegmat_demo';
  status: { level: string; reason: string; state: string; score: number | null };
  segments: Segment[];
  bookmarks: Segment[];
  ended: boolean;
  bookmarkCooldownS: number;
  config: { lowAttentionMax: number; smoothingTauMs: number; minimumLossMs: number };
  fusion: {
    calibrated: boolean;
    baselineProgress: number;
    eegWeight: number;
    gazeWeight: number;
    eegScore: number | null;
    gazeAwayFraction: number | null;
    combinedLoss: number | null;
    threshold: number;
    reason: string;
  } | null;
  events: { type: string; payload: unknown }[];
}

const stateFor = (s: PlaybackStatus) => s.seeking ? 'seeking' : s.ended ? 'ended' : s.paused ? 'paused' : s.buffering ? 'buffering' : 'playing';

async function request(path: string, method: string, body?: unknown) {
  const response = await fetch(`/evaluation-api${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Evaluation service ${response.status}. Check the Python server, then reconnect.`);
  return response.json();
}

/** Independent evaluation observer; existing LecturePlayer owns its telemetry. */
export function observeEvaluation(
  player: PlayerHandle, videoId: string, durationS: number,
  update: (s: EvaluationSnapshot) => void, error: (message: string) => void,
  options: { combineGaze: boolean; readGaze: () => GazeWindow | null } = { combineGaze: false, readGaze: () => null },
) {
  let disposed = false;
  let sessionId: string | null = null;
  let seq = 0;
  let lastSignature = '';
  let stop = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let queue = Promise.resolve();
  let failed = false;

  const send = () => {
    const s = player.getState();
    const body = { seq: ++seq, mediaS: s.mediaTimeS, state: stateFor(s), playbackRate: s.playbackRate, replaying: s.replay !== null, gaze: options.combineGaze ? options.readGaze() : null };
    queue = queue.then(async () => {
      if (disposed || failed || !sessionId) return;
      const snapshot: EvaluationSnapshot = await request(`/sessions/${sessionId}/tick`, 'POST', body);
      if (!disposed) update(snapshot);
    }).catch((e: Error) => { failed = true; if (!disposed) error(e.message); });
  };
  void request('/sessions', 'POST', { videoId, durationS, combineGaze: options.combineGaze }).then((snapshot: EvaluationSnapshot) => {
    sessionId = snapshot.sessionId;
    if (disposed) { void request(`/sessions/${sessionId}`, 'DELETE').catch(() => {}); return; }
    update(snapshot);
    stop = player.subscribe(() => {
      const s = player.getState();
      const signature = `${stateFor(s)}:${s.playbackRate}:${s.replay !== null}`;
      if (signature !== lastSignature) { lastSignature = signature; send(); }
    });
    send();
    timer = setInterval(send, 1000);
  }).catch((e: Error) => { if (!disposed) error(e.message); });
  return () => {
    disposed = true;
    stop();
    clearInterval(timer);
    if (sessionId) void request(`/sessions/${sessionId}`, 'DELETE').catch(() => {});
  };
}
