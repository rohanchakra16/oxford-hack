import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { LecturePlayer, formatMediaTime, type LoadedLecture, type PlayerHandle } from '../../frontend/src/player';
import { SyntheticReviewClient } from '../../frontend/src/integration/synthetic/client';
import { observeEvaluation, type EvaluationSnapshot, type Segment } from './client';
import { GazeWindowBuffer } from './gaze';
import { GazeCalibration } from './GazeCalibration';
import './style.css';

const SESSION = { runKind: 'simulated' as const, sensors: { eeg: false, gaze: false } };
const NOOP_SUBSCRIBE = () => () => {};

function App() {
  // Existing player session plumbing, with timer-based example bookmarks disabled.
  const [client] = useState(() => new SyntheticReviewClient({ scenario: { bookmarkEveryS: 1e9, sensors: [] } }));
  const [gaze] = useState(() => new GazeWindowBuffer());
  const [combineGaze] = useState(() => new URLSearchParams(location.search).get('signals') !== 'eeg');
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const [lecture, setLecture] = useState<LoadedLecture | null>(null);
  const [snapshot, setSnapshot] = useState<EvaluationSnapshot | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Segment | null>(null);
  const duration = useSyncExternalStore(player?.subscribe ?? NOOP_SUBSCRIBE, () => player?.getState().durationS ?? null);

  useEffect(() => { client.connect(); return () => client.dispose(); }, [client]);
  useEffect(() => {
    setSnapshot(null); setError(''); setDismissed(new Set()); setNotice(null);
    if (!player || !lecture || !duration) return;
    const seen = new Set<string>();
    return observeEvaluation(player, lecture.videoId, duration, (next) => {
      setSnapshot(next);
      for (const segment of next.bookmarks) {
        if (!seen.has(segment.segmentId)) { seen.add(segment.segmentId); setNotice(segment); }
      }
    }, (message) => { setError(message); setNotice(null); }, { combineGaze, readGaze: () => gaze.read() });
  }, [player, lecture, duration, attempt, combineGaze, gaze]);

  const replay = (segment: Segment) => {
    if (!player) return;
    setNotice(null);
    const { startMediaS, endMediaS } = segment.mediaRange;
    if (endMediaS <= startMediaS) return;
    void player.replayRange(startMediaS, endMediaS).catch((e: Error) => setError(e.message));
  };
  const bookmarks = snapshot?.bookmarks ?? [];

  return <main>
    <header><p className="eyebrow">Recallroom · player evaluation</p><h1>Watch, notice, revisit.</h1>
      <p>The lecture player is connected directly to the Python evaluation model. Video stays in your browser.</p></header>
    <div className="prototype" role="status"><strong>Evaluation mode · {snapshot?.source === 'eegmat_demo' ? 'EEGMAT workload proxy' : 'scripted signals'}</strong>
      <span>Prototype estimates, not measured attention. EEG uses {snapshot?.source === 'eegmat_demo' ? 'offline workload scores' : 'scripted scores'}{combineGaze ? '; calibrated webcam gaze runs locally' : ''}. This view does not use a live EEG headset.</span></div>
    <div className="layout"><section>
      <LecturePlayer client={client} session={SESSION} ref={setPlayer} onLectureChange={setLecture} />
      {bookmarks.length > 0 && <nav className="bookmark-flags" aria-label="Saved bookmark flags">
        <strong>Saved flags</strong>
        {bookmarks.map((bookmark) => <button key={bookmark.segmentId} disabled={bookmark.mediaRange.endMediaS <= bookmark.mediaRange.startMediaS} aria-label={`Replay bookmark at ${formatMediaTime(bookmark.mediaRange.startMediaS)}`} onClick={() => replay(bookmark)}>
          <span aria-hidden="true">⚑ </span>{formatMediaTime(bookmark.mediaRange.startMediaS)}
        </button>)}
      </nav>}
      <div className="settings"><strong>Conservative detection</strong><p>{combineGaze ? `EEG loss (60%) + calibrated look-away (40%): combined loss must reach ${(1 - (snapshot?.config.lowAttentionMax ?? 0.3)).toFixed(2)}.` : `Low-score trigger ${(snapshot?.config.lowAttentionMax ?? 0.3).toFixed(2)}.`} Estimates use {(snapshot?.config.smoothingTauMs ?? 5000) / 1000} s smoothing and must stay low for {(snapshot?.config.minimumLossMs ?? 8000) / 1000} s. Automatic bookmarks are at least 30 s apart.</p>
        {!combineGaze && snapshot?.source !== 'eegmat_demo' && <p>Smoke sequence: a brief dip at 0:03–0:05 is ignored; a sustained dip at 0:10–0:36 should save one moment. Use a video at least 40 seconds long.</p>}
        {snapshot?.source === 'eegmat_demo' && <p>Offline workload scores follow an explicitly hypothetical lecture timeline. Outside their coverage the estimate is unknown.</p>}</div>
    </section><aside>
      {combineGaze && <GazeCalibration key={lecture?.videoId ?? 'none'} player={player} buffer={gaze} />}
      <section className="panel"><h2>Evaluation status</h2><p data-testid="evaluation-status">{error ? 'Unavailable' : snapshot ? snapshot.status.level : lecture ? 'Connecting…' : 'Open a local lecture to begin'}</p>
        {snapshot && <p>{snapshot.status.reason}</p>}
        {snapshot?.fusion && <div data-testid="fusion-status"><p>{snapshot.fusion.reason}</p>
          {!snapshot.fusion.calibrated && <progress aria-label="Focused baseline calibration" value={snapshot.fusion.baselineProgress} max={1} />}
          <p>Combined loss: {snapshot.fusion.combinedLoss?.toFixed(2) ?? 'unknown'} · threshold {snapshot.fusion.threshold.toFixed(2)}</p>
        </div>}
        {error && <><p role="alert">{error}</p><button onClick={() => setAttempt((n) => n + 1)}>Reconnect evaluation</button></>}
      </section>
      {notice && !snapshot?.ended && <section className="heads-up" role="status" data-testid="heads-up"><strong>Heads-up: review moment saved</strong><p>You may want to revisit {formatMediaTime(notice.mediaRange.startMediaS)} when you’re ready.</p><button disabled={notice.mediaRange.endMediaS <= notice.mediaRange.startMediaS} onClick={() => replay(notice)}>Replay saved moment</button><button onClick={() => setNotice(null)}>Close heads-up</button></section>}
      <section className="panel" aria-label="Review bookmarks"><h2>{snapshot?.ended ? 'End-of-lecture bookmarks' : 'Review moments'} <span data-testid="bookmark-count">{bookmarks.length}</span></h2>
        {snapshot?.ended && <p role="status" data-testid="end-review">Lecture complete. Choose a saved flag to revisit a moment.</p>}
        <p>Nothing pauses or rewinds automatically. New bookmarks have a {snapshot?.bookmarkCooldownS ?? 30} s cooldown.</p>
        {!bookmarks.length && <p>No review moments yet</p>}
        {bookmarks.map((segment) => <article key={segment.segmentId} data-testid="review-moment">
          <strong>Review {formatMediaTime(segment.mediaRange.startMediaS)}–{formatMediaTime(segment.mediaRange.endMediaS)}</strong>
          <time dateTime={`PT${segment.mediaRange.startMediaS}S`}>{formatMediaTime(segment.mediaRange.startMediaS)}</time>
          {dismissed.has(segment.segmentId) ? <p>Dismissed</p> : <div><button disabled={segment.mediaRange.endMediaS <= segment.mediaRange.startMediaS} onClick={() => replay(segment)}>Replay</button><button onClick={() => setDismissed((old) => new Set(old).add(segment.segmentId))}>Dismiss</button></div>}
        </article>)}
      </section>
    </aside></div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
