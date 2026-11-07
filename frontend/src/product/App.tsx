import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createReviewClient,
  useReviewConnection,
  useReviewSnapshot,
  type ReviewBookmark as WireReviewBookmark,
  type ReviewClient,
  type SensorState,
} from '../integration';
import { LecturePlayer, formatMediaTime as formatTime, type LoadedLecture, type PlayerHandle } from '../player';
import { TranscriptPanel, sentenceIndexAt, replayStartFor, type Sentence, type Transcript } from '../transcript';
import './product.css';
import { useFocusReview } from '../focus/useFocusReview';
import { FocusSetup } from '../focus/FocusSetup';

type ReviewBookmark = Pick<WireReviewBookmark, 'bookmarkId' | 'source' | 'videoId' | 'suggestedMediaS'> & { endMediaS?: number };

const NOOP_SUBSCRIBE = () => () => {};
const NO_SENTENCES: readonly Sentence[] = [];

const sensorLabels = { eeg: 'EEG headset', gaze: 'Webcam gaze' } as const;

function statusLabel(status: SensorState['state'] | undefined): string {
  if (!status) return 'Waiting for status';
  return status.replaceAll('_', ' ');
}

function sourceLabel(source: ReviewBookmark['source']): string {
  switch (source) {
    case 'experimental_eeg':
      return 'EEG signal';
    case 'experimental_gaze':
      return 'Gaze signal';
    case 'experimental_combined':
      return 'Combined signals';
    case 'manual':
      return 'Your marker';
  }
}

/** The sentence a replay starts in (shared rule: containing sentence, `earlier` whole sentences back). */
function passageFor(sentences: readonly Sentence[], timeS: number, earlier: number) {
  const containing = sentenceIndexAt(sentences, timeS);
  if (containing < 0) return null;
  const start = replayStartFor(sentences, timeS, earlier);
  const index = sentenceIndexAt(sentences, start);
  const sentence = sentences[index]!;
  return { index, startS: start, endS: sentences[containing]!.endS, text: sentence.text };
}

function BookmarkCard({
  bookmark,
  sentences,
  dismissed,
  earlierCount,
  onReplay,
  onDismiss,
  onEarlier,
  onRate,
}: {
  bookmark: ReviewBookmark;
  sentences: readonly Sentence[];
  dismissed: boolean;
  earlierCount: number;
  onReplay: (bookmark: ReviewBookmark) => void;
  onDismiss: (bookmark: ReviewBookmark) => void;
  onEarlier: (bookmark: ReviewBookmark) => void;
  onRate: (bookmark: ReviewBookmark, useful: boolean) => void;
}) {
  const passage = passageFor(sentences, bookmark.suggestedMediaS, earlierCount);

  return (
    <article className={`bookmark-card${dismissed ? ' bookmark-card--dismissed' : ''}`}>
      <div className="bookmark-card__marker" aria-hidden="true">
        <span />
      </div>
      <div className="bookmark-card__content">
        <div className="bookmark-card__heading">
          <div>
            <p className="eyebrow">{sourceLabel(bookmark.source)}</p>
            <h3>{passage?.text ?? 'Review this moment'}</h3>
          </div>
          <time className="time-chip" dateTime={`PT${bookmark.suggestedMediaS}S`}>
            {formatTime(bookmark.suggestedMediaS)}
          </time>
        </div>
        <p className="bookmark-card__note">
          Suggested replay · {passage ? formatTime(passage.startS) : formatTime(bookmark.suggestedMediaS)}
          {earlierCount > 0 && <span> · moved earlier {earlierCount} {earlierCount === 1 ? 'passage' : 'passages'}</span>}
        </p>
        {dismissed ? (
          <p className="dismissed-note" role="status">Dismissed for this view</p>
        ) : (
          <div className="bookmark-actions">
            <button className="button button--primary button--small" type="button" onClick={() => onReplay(bookmark)}>
              Replay
            </button>
            {passage && (
              <button
                className="button button--quiet button--small"
                type="button"
                onClick={() => onEarlier(bookmark)}
                disabled={passage.index === 0}
                aria-label={`Move replay earlier for ${formatTime(bookmark.suggestedMediaS)}`}
              >
                Move earlier
              </button>
            )}
            <button
              className="button button--quiet button--small"
              type="button"
              onClick={() => onDismiss(bookmark)}
            >
              Dismiss
            </button>
            <div className="feedback-actions" aria-label="Was this suggestion helpful?">
              <button
                className="icon-button"
                type="button"
                aria-label="Mark suggestion useful"
                title="Useful"
                onClick={() => onRate(bookmark, true)}
              >
                <span aria-hidden="true">+</span>
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Mark suggestion not useful"
                title="Not useful"
                onClick={() => onRate(bookmark, false)}
              >
                <span aria-hidden="true">−</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function DeviceStatus({ clientKind, sensors }: { clientKind: string; sensors: ReturnType<ReviewClient['getSnapshot']>['sensors'] }) {
  return (
    <section className="device-panel" aria-labelledby="device-title">
      <div className="section-heading section-heading--compact">
        <div>
          <p className="eyebrow">Session setup</p>
          <h2 id="device-title">Your devices</h2>
        </div>
        <span className={`mode-badge${clientKind === 'synthetic' ? ' mode-badge--simulated' : ''}`}>
          <span className="status-dot" />
          {clientKind === 'synthetic' ? 'Simulated' : 'Live'}
        </span>
      </div>
      <p className="device-panel__intro">
        Device availability is reported by the session. Signal status is separate from review suggestions.
      </p>
      <div className="device-list">
        {(['eeg', 'gaze'] as const).map((name) => {
          const sensor = sensors?.[name];
          const state = sensor?.state;
          const tone = state === 'ok' ? 'good' : state === 'lost' || state === 'unavailable' ? 'muted' : 'waiting';
          return (
            <div className="device-row" key={name}>
              <span className={`device-icon device-icon--${name}`} aria-hidden="true">
                {name === 'eeg' ? '∿' : '◉'}
              </span>
              <span className="device-row__name">{sensorLabels[name]}</span>
              <span className={`device-state device-state--${tone}`}>
                <span className="status-dot" />
                {statusLabel(state)}
              </span>
            </div>
          );
        })}
      </div>
      {sensors && !sensors.automaticSuggestions && (
        <p className="device-advisory" role="status">
          Automatic suggestions are unavailable right now. You can still add your own markers.
        </p>
      )}
    </section>
  );
}

export default function App() {
  const [client] = useState(() => createReviewClient());
  useReviewConnection(client);
  const snapshot = useReviewSnapshot(client);
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const [lecture, setLecture] = useState<LoadedLecture | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [earlierCounts, setEarlierCounts] = useState<Record<string, number>>({});

  useEffect(() => () => client.dispose(), [client]);

  // The player owns the media element, telemetry and the session lifecycle (startSession/endSession).
  const sessionSettings = useMemo(
    () => ({ runKind: client.kind === 'synthetic' ? ('simulated' as const) : ('live' as const), sensors: { eeg: true, gaze: true } }),
    [client],
  );
  const currentTime = useSyncExternalStore(
    player?.subscribe ?? NOOP_SUBSCRIBE,
    () => player?.getState().mediaTimeS ?? 0,
    () => 0,
  );
  const duration = useSyncExternalStore(
    player?.subscribe ?? NOOP_SUBSCRIBE,
    () => player?.getState().durationS ?? null,
    () => null,
  );
  const sentences = transcript?.sentences ?? NO_SENTENCES;
  const focus = useFocusReview(player, lecture, duration);
  const ended = useSyncExternalStore(player?.subscribe ?? NOOP_SUBSCRIBE, () => player?.getState().ended ?? false);

  const activeBookmarks = useMemo(
    () => [...snapshot.bookmarks.filter((bookmark) => (!lecture || bookmark.videoId === lecture.videoId) && (!focus.enabled || bookmark.source === 'manual')), ...focus.moments]
      .sort((a, b) => a.suggestedMediaS - b.suggestedMediaS),
    [snapshot.bookmarks, lecture, focus.enabled, focus.moments],
  );

  const onLectureChange = (next: LoadedLecture | null) => {
    setLecture(next);
    setDismissed(new Set());
    setEarlierCounts({});
    setTranscript(null);
  };

  const replay = (bookmark: ReviewBookmark) => {
    if (!player) return;
    const count = earlierCounts[bookmark.bookmarkId] ?? 0;
    const passage = passageFor(sentences, bookmark.suggestedMediaS, count);
    const target = passage?.startS ?? bookmark.suggestedMediaS;
    // With a transcript, replay is bounded to the end of the sentence containing the suggested moment;
    // without one it seeks and keeps playing (nothing here pauses or seeks on its own).
    if (passage) void player.replayRange(target, Math.max(passage.endS, target + 3)).catch(() => undefined);
    else if (bookmark.endMediaS !== undefined) {
      void player.replayRange(target, bookmark.endMediaS).catch(() => undefined);
    } else {
      player.seek(target);
      void player.play().catch(() => undefined);
    }
    if (!bookmark.bookmarkId.startsWith('focus:')) client.sendFeedback(bookmark.bookmarkId, 'replay', target);
    focus.closeNotice();
  };

  const dismiss = (bookmark: ReviewBookmark) => {
    if (!bookmark.bookmarkId.startsWith('focus:')) client.sendFeedback(bookmark.bookmarkId, 'dismiss', currentTime);
    setDismissed((previous) => new Set(previous).add(bookmark.bookmarkId));
  };

  const moveEarlier = (bookmark: ReviewBookmark) => {
    const count = (earlierCounts[bookmark.bookmarkId] ?? 0) + 1;
    setEarlierCounts((previous) => ({ ...previous, [bookmark.bookmarkId]: count }));
    const target = passageFor(sentences, bookmark.suggestedMediaS, count)?.startS ?? bookmark.suggestedMediaS;
    if (!bookmark.bookmarkId.startsWith('focus:')) client.sendFeedback(bookmark.bookmarkId, 'move_earlier', target);
  };

  const rate = (bookmark: ReviewBookmark, useful: boolean) => {
    if (!bookmark.bookmarkId.startsWith('focus:')) client.sendFeedback(bookmark.bookmarkId, useful ? 'rated_useful' : 'rated_not_useful', currentTime);
  };

  const connection = snapshot.connection;
  const connectionTone = connection.state === 'connected'
    ? 'connected'
    : connection.state === 'connecting' || connection.state === 'reconnecting'
      ? 'pending'
      : 'attention';

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Lecture Recovery home">
          <span className="brand-mark" aria-hidden="true">r.</span>
          <span>recall<span className="brand-light">room</span></span>
        </a>
        <div className="topbar__right">
          <span className={`connection-pill connection-pill--${connectionTone}`} role="status">
            <span className="status-dot" />
            {connection.state === 'connected'
              ? snapshot.kind === 'synthetic' ? 'Simulation ready' : 'Session connected'
              : connection.state === 'connecting' || connection.state === 'reconnecting'
                ? 'Connecting'
                : connection.state === 'pairing_required'
                  ? 'Pairing needed'
                  : connection.state === 'incompatible'
                    ? 'Version mismatch'
                    : snapshot.kind === 'synthetic' ? 'Simulation stopped' : 'Not connected'}
          </span>
          <a className="diagnostics-link" href="/diagnostics">System status</a>
        </div>
      </header>

      <main className="workspace">
        <section className="welcome-row">
          <div>
            <p className="eyebrow">A calmer way to catch up</p>
            <h1>Find your way back<br className="desktop-break" /> to the lecture.</h1>
            <p className="welcome-copy">
              Watch at your pace. Mark a moment, then replay the passage when you&apos;re ready.
            </p>
          </div>
          <div className="privacy-note">
            <span aria-hidden="true">✳</span>
            <p><strong>Your lecture stays yours.</strong><br />Video is processed locally in your browser.</p>
          </div>
        </section>

        {snapshot.kind === 'synthetic' && (
          <div className="mode-banner" role="status">
            <span className="mode-banner__icon" aria-hidden="true">✦</span>
            <div>
              <strong>Simulation mode</strong>
              <span>Example suggestions and device states are simulated. They are not real attention measurements.</span>
            </div>
          </div>
        )}

        {connection.state !== 'connected' && connection.state !== 'idle' && (
          <div className={`connection-banner connection-banner--${connectionTone}`} role="status">
            <strong>
              {connection.state === 'pairing_required' ? 'Connect to your session' :
                connection.state === 'incompatible' ? 'Update needed' :
                  connection.state === 'reconnecting' ? 'Connection interrupted' :
                    connection.state === 'closed' ? 'Session disconnected' : 'Connecting to session'}
            </strong>
            <span>{connection.detail}</span>
          </div>
        )}

        {snapshot.errors.length > 0 && (
          <div className="error-banner" role="alert">
            <strong>Session message</strong>
            <span>{snapshot.errors[snapshot.errors.length - 1]?.message}</span>
          </div>
        )}

        <div className="content-grid">
          <div className="main-column">
            <section className="player-card" aria-label="Lecture video">
              <LecturePlayer client={client} session={sessionSettings} ref={setPlayer} onLectureChange={onLectureChange} />
              {activeBookmarks.length > 0 && <nav aria-label="Saved bookmark flags" className="player-tools">
                {activeBookmarks.map((bookmark) => <button className="button button--quiet button--small" key={bookmark.bookmarkId} onClick={() => replay(bookmark)} aria-label={`Replay bookmark at ${formatTime(bookmark.suggestedMediaS)}`}>
                  <span aria-hidden="true">⚑ </span>{formatTime(bookmark.suggestedMediaS)}
                </button>)}
              </nav>}
              <div className="player-card__footer">
                <div className="lecture-file">
                  <span className="file-icon" aria-hidden="true">▶</span>
                  <div>
                    <strong title={lecture?.fileName}>{lecture?.fileName ?? 'No lecture open'}</strong>
                    <span>{duration ? `${formatTime(duration)} lecture` : 'Local video, never uploaded'}</span>
                  </div>
                </div>
                <div className="player-tools">
                  <button
                    className="button button--outline button--small"
                    type="button"
                    disabled={!snapshot.session || !lecture}
                    title={snapshot.session ? 'Add a review marker at the current time' : 'Waiting for an active session'}
                    onClick={() => client.markBookmark(currentTime)}
                    aria-label={`Mark this moment at ${formatTime(currentTime)}`}
                  >
                    <span aria-hidden="true">◆</span> Mark moment
                  </button>
                </div>
              </div>
            </section>

            <section className="transcript-card" aria-labelledby="transcript-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Follow along</p>
                  <h2 id="transcript-title">Transcript</h2>
                </div>
              </div>
              {/* key: a new lecture starts without the previous lecture's transcript */}
              <TranscriptPanel key={lecture?.videoId ?? 'none'} player={player} onTranscriptChange={setTranscript} />
            </section>
          </div>

          <aside className="side-column" aria-label="Session and review">
            <FocusSetup player={player} lecture={lecture} focus={focus} />
            {focus.notice && !ended && !focus.snapshot?.ended && <section className="focus-tools" role="status" aria-label="Focus heads-up">
              <strong>Heads-up: review moment saved</strong>
              <p>You may want to revisit {formatTime(focus.notice.mediaRange.startMediaS)} when you’re ready.</p>
              <button onClick={() => { const bookmark = focus.moments.find((b) => b.suggestedMediaS === focus.notice!.mediaRange.startMediaS); if (bookmark) replay(bookmark); }}>Replay saved moment</button>
              <button onClick={focus.closeNotice}>Close heads-up</button>
            </section>}
            <DeviceStatus clientKind={snapshot.kind} sensors={snapshot.sensors} />

            <section className="review-panel" aria-labelledby="review-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Your checkpoints</p>
                  <h2 id="review-title">{ended || focus.snapshot?.ended ? 'End-of-lecture bookmarks' : 'Review moments'} <span className="count-badge">{activeBookmarks.length}</span></h2>
                </div>
              </div>
              <p className="review-intro">
                Moments are suggestions to review, not judgments about your attention.
              </p>
              {(ended || focus.snapshot?.ended) && <p role="status">Lecture complete. Choose a saved flag to revisit a moment.</p>}
              {snapshot.sensors && !snapshot.sensors.automaticSuggestions && (
                <div className="manual-only-note" role="status">
                  Automatic suggestions are paused. Add a marker whenever you want to revisit a moment.
                </div>
              )}
              {activeBookmarks.length > 0 ? (
                <div className="bookmark-list">
                  {activeBookmarks.map((bookmark) => (
                    <BookmarkCard
                      key={bookmark.bookmarkId}
                      bookmark={bookmark}
                      sentences={sentences}
                      dismissed={dismissed.has(bookmark.bookmarkId)}
                      earlierCount={earlierCounts[bookmark.bookmarkId] ?? 0}
                      onReplay={replay}
                      onDismiss={dismiss}
                      onEarlier={moveEarlier}
                      onRate={rate}
                    />
                  ))}
                </div>
              ) : (
                <div className="review-empty">
                  <span className="review-empty__icon" aria-hidden="true">✳</span>
                  <strong>No review moments yet</strong>
                  <p>Start the lecture to receive suggestions, or add a marker at any moment.</p>
                  {!lecture && <span className="review-empty__hint">Your moments will appear here.</span>}
                </div>
              )}
            </section>

            <div className="session-note">
              <span aria-hidden="true">⌁</span>
              <p><strong>Made for your own pace</strong><br />Nothing pauses or rewinds automatically. You choose what to revisit.</p>
            </div>
          </aside>
        </div>
      </main>

      <footer className="page-footer">
        <span>recallroom</span>
        <span>Learning, at your pace.</span>
      </footer>
    </div>
  );
}
