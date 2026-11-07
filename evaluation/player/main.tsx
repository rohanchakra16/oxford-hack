import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { LecturePlayer, formatMediaTime, type LoadedLecture, type PlayerHandle } from '../../frontend/src/player';
import { SyntheticReviewClient } from '../../frontend/src/integration/synthetic/client';
import { observeEvaluation, type EvaluationSnapshot, type Segment } from './client';
import './style.css';

const SESSION = { runKind: 'simulated' as const, sensors: { eeg: false, gaze: false } };
const NOOP_SUBSCRIBE = () => () => {};

function App() {
  // Existing player session plumbing, with timer-based example bookmarks disabled.
  const [client] = useState(() => new SyntheticReviewClient({ scenario: { bookmarkEveryS: 1e9, sensors: [] } }));
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
      for (const segment of next.segments) {
        if (!seen.has(segment.segmentId)) { seen.add(segment.segmentId); setNotice(segment); }
      }
    }, (message) => { setError(message); setSnapshot(null); setNotice(null); });
  }, [player, lecture, duration, attempt]);

  const replay = (segment: Segment) => {
    if (!player) return;
    const { startMediaS, endMediaS } = segment.mediaRange;
    void player.replayRange(startMediaS, endMediaS).catch((e: Error) => setError(e.message));
  };

  return <main>
    <header><p className="eyebrow">Recallroom · player evaluation</p><h1>Watch, notice, revisit.</h1>
      <p>The lecture player is connected directly to the Python evaluation model. Video stays in your browser.</p></header>
    <div className="prototype" role="status"><strong>Evaluation mode · {snapshot?.source === 'eegmat_demo' ? 'EEGMAT workload proxy' : 'scripted signals'}</strong>
      <span>Prototype estimates, not measured attention. This view does not use a live EEG headset.</span></div>
    <div className="layout"><section>
      <LecturePlayer client={client} session={SESSION} ref={setPlayer} onLectureChange={setLecture} />
      <div className="settings"><strong>Conservative detection</strong><p>Lower trigger score (0.30), 5 s smoothing, and 8 s of sustained low estimates before saving a review moment.</p>
        {snapshot?.source !== 'eegmat_demo' && <p>Smoke sequence: a brief dip at 0:03–0:05 is ignored; a sustained dip at 0:10–0:36 should save one moment. Use a video at least 40 seconds long.</p>}
        {snapshot?.source === 'eegmat_demo' && <p>Offline workload scores follow an explicitly hypothetical lecture timeline. Outside their coverage the estimate is unknown.</p>}</div>
    </section><aside>
      <section className="panel"><h2>Evaluation status</h2><p data-testid="evaluation-status">{error ? 'Unavailable' : snapshot ? snapshot.status.level : lecture ? 'Connecting…' : 'Open a local lecture to begin'}</p>
        {snapshot && <p>{snapshot.status.reason}</p>}
        {error && <><p role="alert">{error}</p><button onClick={() => setAttempt((n) => n + 1)}>Reconnect evaluation</button></>}
      </section>
      {notice && <section className="heads-up" role="status" data-testid="heads-up"><strong>Heads-up: review moment saved</strong><p>You may want to revisit {formatMediaTime(notice.mediaRange.startMediaS)} when you’re ready.</p><button onClick={() => setNotice(null)}>Close heads-up</button></section>}
      <section className="panel"><h2>Review moments <span data-testid="bookmark-count">{snapshot?.segments.length ?? 0}</span></h2>
        <p>Nothing pauses or rewinds automatically.</p>
        {!snapshot?.segments.length && <p>No review moments yet</p>}
        {snapshot?.segments.map((segment) => <article key={segment.segmentId} data-testid="review-moment">
          <strong>Review {formatMediaTime(segment.mediaRange.startMediaS)}–{formatMediaTime(segment.mediaRange.endMediaS)}</strong>
          <time dateTime={`PT${segment.mediaRange.startMediaS}S`}>{formatMediaTime(segment.mediaRange.startMediaS)}</time>
          {dismissed.has(segment.segmentId) ? <p>Dismissed</p> : <div><button onClick={() => replay(segment)}>Replay</button><button onClick={() => setDismissed((old) => new Set(old).add(segment.segmentId))}>Dismiss</button></div>}
        </article>)}
      </section>
    </aside></div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
