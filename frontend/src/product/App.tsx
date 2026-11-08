import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createReviewClient,
  useReviewConnection,
  useReviewSnapshot,
  type ReviewBookmark as WireReviewBookmark,
  type ReviewClient,
  type SensorState,
} from '../integration';
import { LecturePlayer, formatMediaTime as formatTime, type LoadedLecture, type PlayerHandle, type PlayerViewMode } from '../player';
import { AttentionTimelineStore, AttentionGraph, AttentionSummary, AttentionInfoIndicator, AttentionDemoPanel, markerFromBookmark, observationFromEvaluation, useAttentionLecture, useTimeline, type AttentionMarker, type SeekTarget } from '../attention';
import { usePersonalAttention } from '../focus/usePersonalAttention';
import { Wordmark } from './Wordmark';
import { TranscriptPanel, sentenceIndexAt, replayStartFor, type Sentence, type Transcript } from '../transcript';
import { FlagIcon } from './icons';
import { planReplay } from './replayPlan';
import { useFocusReview } from '../focus/useFocusReview';
import { SessionSetup } from './SessionSetup';
import { useExperiment } from '../experiment/useExperiment';
import './product.css'; // last: must load after the player, transcript and focus styles it refines

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
  const [rated, setRated] = useState<'useful' | 'not_useful' | null>(null);

  return (
    <article className={`bookmark-card${dismissed ? ' bookmark-card--dismissed' : ''}`}>
      <div className="bookmark-card__content">
        <div className="bookmark-card__heading">
          <time className="time-chip" dateTime={`PT${bookmark.suggestedMediaS}S`}>
            {formatTime(bookmark.suggestedMediaS)}
          </time>
          <span className="bookmark-card__source">{sourceLabel(bookmark.source)}</span>
        </div>
        <h3>{passage?.text ?? 'Review this moment'}</h3>
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
            <div className="feedback-actions" role="group" aria-label="Was this suggestion helpful?">
              {rated ? (
                <span className="feedback-thanks" role="status">Thanks, noted.</span>
              ) : (
                <>
                  <button className="button button--quiet button--small" type="button" aria-label="Mark suggestion useful" onClick={() => { setRated('useful'); onRate(bookmark, true); }}>
                    Helpful
                  </button>
                  <button className="button button--quiet button--small" type="button" aria-label="Mark suggestion not useful" onClick={() => { setRated('not_useful'); onRate(bookmark, false); }}>
                    Not helpful
                  </button>
                </>
              )}
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
        <h2 id="device-title">Your devices</h2>
        <span className={`mode-badge${clientKind === 'synthetic' ? ' mode-badge--simulated' : ''}`}>
          <span className="status-dot" />
          {clientKind === 'synthetic' ? 'Simulated' : 'Live'}
        </span>
      </div>
      <div className="device-list">
        {(['eeg', 'gaze'] as const).map((name) => {
          const sensor = sensors?.[name];
          const state = sensor?.state;
          const tone = state === 'ok' ? 'good' : state === 'lost' || state === 'unavailable' ? 'muted' : 'waiting';
          return (
            <div className="device-row" key={name}>
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
  const [lectureFileTarget, setLectureFileTarget] = useState<HTMLDivElement | null>(null);
  const [transcriptFileTarget, setTranscriptFileTarget] = useState<HTMLDivElement | null>(null);
  const [client] = useState(() => createReviewClient());
  useReviewConnection(client);
  const snapshot = useReviewSnapshot(client);
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const [lecture, setLecture] = useState<LoadedLecture | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [earlierCounts, setEarlierCounts] = useState<Record<string, number>>({});
  const [reminders, setReminders] = useState<WireReviewBookmark[]>([]);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [liveAttentionStore] = useState(() => new AttentionTimelineStore());
  const experiment = useExperiment(player, lecture?.videoId);
  const attentionStore = experiment.enabled ? experiment.store : liveAttentionStore;
  const [viewMode, setViewMode] = useState<PlayerViewMode>('normal');
  const [showSummary, setShowSummary] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() => new URLSearchParams(window.location.search).get('setup') === '1');
  const timeline = useTimeline(attentionStore);
  useAttentionLecture(liveAttentionStore, player);
  const personalAttention = usePersonalAttention(client, experiment.enabled ? undefined : snapshot.session?.sessionId, lecture?.videoId, liveAttentionStore);

  useEffect(() => client.onEvent((event) => {
    if (event.type === 'session_started' || event.type === 'session_ended') setReminders([]);
    if (!experiment.enabled && event.type === 'bookmark_added' && event.bookmark.source !== 'manual') {
      setReminders((saved) => saved.some((b) => b.bookmarkId === event.bookmark.bookmarkId)
        ? saved : [...saved, event.bookmark]);
    }
  }), [client, experiment.enabled]);

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
  const focus = useFocusReview(player, lecture, duration, client);
  const ended = useSyncExternalStore(player?.subscribe ?? NOOP_SUBSCRIBE, () => player?.getState().ended ?? false);

  const activeBookmarks = useMemo(
    () => [...snapshot.bookmarks.filter((bookmark) => (!lecture || bookmark.videoId === lecture.videoId) && (experiment.enabled ? bookmark.source === 'manual' : (client.kind === 'live' || !focus.enabled || bookmark.source === 'manual'))), ...(experiment.enabled
      ? timeline.markers.filter((marker) => marker.kind === 'review').map((marker) => ({ bookmarkId: `focus:${marker.id}`,
        videoId: lecture?.videoId ?? '', suggestedMediaS: marker.startS, endMediaS: marker.endS ?? undefined, source: 'experimental_combined' as const }))
      : focus.moments)]
      .sort((a, b) => a.suggestedMediaS - b.suggestedMediaS),
    [snapshot.bookmarks, lecture, focus.enabled, focus.moments, client, experiment.enabled, timeline.markers],
  );

  useEffect(() => {
    if (!lecture || experiment.enabled) return;
    for (const bookmark of activeBookmarks) attentionStore.addMarker(markerFromBookmark({ ...bookmark, runKind: client.kind === 'synthetic' ? 'simulated' : 'live' }));
  }, [activeBookmarks, lecture, attentionStore, client, experiment.enabled]);
  useEffect(() => {
    if (experiment.enabled || client.kind !== 'synthetic' || !focus.snapshot || !player) return;
    const observation = observationFromEvaluation(focus.snapshot, player.getState());
    if (observation) attentionStore.record({ ...observation, origin: 'simulated' });
  }, [focus.snapshot, client, player, attentionStore, experiment.enabled]);
  useEffect(() => { if (ended) setShowSummary(true); }, [ended]);
  useEffect(() => { setShowSummary(false); }, [lecture?.videoId]);

  const onLectureChange = (next: LoadedLecture | null) => {
    setLecture(next);
    setDismissed(new Set());
    setEarlierCounts({});
    setReminders([]);
    setReplayError(null);
    setTranscript(null);
  };

  const replay = (bookmark: ReviewBookmark) => {
    if (!player) {
      setReplayError('Load the lecture video before replaying a moment.');
      return;
    }
    const count = earlierCounts[bookmark.bookmarkId] ?? 0;
    // Passage start follows the shared sentence rule; a range the player cannot replay (unfinished,
    // zero-length, past the end) falls back to seeking and playing from the start.
    const plan = planReplay(sentences, bookmark, count, duration);
    const started = plan.endS === null
      ? (player.seek(plan.startS), player.play())
      : player.replayRange(plan.startS, plan.endS);
    setReplayError(null);
    started.catch((error: unknown) => {
      setReplayError(`Replay could not start: ${error instanceof Error ? error.message : 'the browser blocked playback'}. Press play on the video, then try again.`);
    });
    if (!bookmark.bookmarkId.startsWith('focus:')) client.sendFeedback(bookmark.bookmarkId, 'replay', plan.startS);
    focus.closeNotice();
  };

  const dismiss = (bookmark: ReviewBookmark) => {
    if (!bookmark.bookmarkId.startsWith('focus:')) client.sendFeedback(bookmark.bookmarkId, 'dismiss', currentTime);
    setDismissed((previous) => new Set(previous).add(bookmark.bookmarkId));
  };

  const seekAttention = (time: number, marker?: AttentionMarker) => {
    if (marker) {
      const bookmark = activeBookmarks.find((b) => b.bookmarkId === marker.id);
      if (bookmark) { replay(bookmark); return; }
    }
    player?.seek(time);
  };
  const seekGraph = (time: number, target: SeekTarget) => seekAttention(time, target.kind === 'marker' ? target.marker : undefined);

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
        <a className="brand" href="/" aria-label="ReMind home">
          <Wordmark />
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
          <button className="button button--outline button--small setup-trigger" onClick={() => setSetupOpen(true)}>Session setup</button>
        </div>
      </header>

      <main className="workspace">
        <section className="welcome-row">
          <div>
            <h1>Find your way back to the lecture.</h1>
            <p className="welcome-copy">
              Watch at your pace. Mark a moment, then replay the passage when you&apos;re ready. Your video stays in this browser.
            </p>
          </div>
        </section>

        {experiment.enabled && <div className="mode-banner" role="status" data-testid="experiment-banner">
          <span className="mode-banner__icon" aria-hidden="true" />
          <div><strong>Experimental mode</strong><span>{experiment.source ? `EEG CSV: ${experiment.source.name} · randomized gaze every 10 seconds.` : 'Import an EEG CSV in Session setup → Calibration → Experimental mode.'} Test scores and review dots are simulated.</span></div>
        </div>}

        {!experiment.enabled && snapshot.kind === 'synthetic' && (
          <div className="mode-banner" role="status">
            <span className="mode-banner__icon" aria-hidden="true" />
            <div>
              <strong>Simulation mode</strong>
              <span>Example suggestions and device states are simulated. They are not real attention measurements.</span>
            </div>
          </div>
        )}

        {!experiment.enabled && snapshot.kind === 'live' && snapshot.session?.config.eegDevice?.model?.startsWith('Scripted test EEG') && (
          <div className="mode-banner" role="status" data-testid="test-eeg-banner">
            <span className="mode-banner__icon" aria-hidden="true" />
            <div>
              <strong>Test EEG + real webcam</strong>
              <span>
                The EEG scores are scripted for rehearsal. No headset is connected, so nothing here reflects your
                brain activity. Gaze, if you enable it, comes from your own camera.
              </span>
            </div>
          </div>
        )}

        {!experiment.enabled && connection.state !== 'connected' && connection.state !== 'idle' && (
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

        {replayError && (
          <div className="error-banner" role="alert" data-testid="replay-error">
            <strong>Replay</strong>
            <span>{replayError}</span>
          </div>
        )}

        {snapshot.errors.length > 0 && (
          <div className="error-banner" role="alert">
            <strong>Session message</strong>
            <span>{snapshot.errors[snapshot.errors.length - 1]?.message}</span>
          </div>
        )}

        <div className="media-file-toolbar" role="group" aria-label="Lecture files">
          <div ref={setLectureFileTarget} />
          <div ref={setTranscriptFileTarget} />
        </div>

        <div className="content-grid">
          <div className="main-column">
            <section className="player-card" aria-label="Lecture video">
              <LecturePlayer client={client} session={sessionSettings} ref={setPlayer} onLectureChange={onLectureChange}
                filePickerTarget={lectureFileTarget}
                viewMode={viewMode} onViewModeChange={setViewMode}
                overlay={<AttentionInfoIndicator store={attentionStore} onSeek={seekAttention} />} />
              {activeBookmarks.length > 0 && <nav aria-label="Saved bookmark flags" className="focus-bookmark-flags">
                {activeBookmarks.map((bookmark) => <button className="button button--quiet button--small" key={bookmark.bookmarkId} onClick={() => replay(bookmark)} aria-label={`Replay bookmark at ${formatTime(bookmark.suggestedMediaS)}`}>
                  <FlagIcon />{formatTime(bookmark.suggestedMediaS)}
                </button>)}
              </nav>}
              <div className="player-card__footer">
                <div className="lecture-file">
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
                    <FlagIcon /> Mark moment
                  </button>
                </div>
              </div>
            </section>

            {showSummary && <AttentionSummary store={attentionStore} playback={player} onSeek={seekGraph} onClose={() => setShowSummary(false)} />}

            <section className="transcript-card" aria-labelledby="transcript-title">
              <div className="section-heading">
                <h2 id="transcript-title">Transcript</h2>
              </div>
              {/* key: a new lecture starts without the previous lecture's transcript */}
              <TranscriptPanel key={lecture?.videoId ?? 'none'} player={player} onTranscriptChange={setTranscript} filePickerTarget={transcriptFileTarget} />
            </section>
          </div>

          <aside className="side-column" aria-label="Session and review">
            <AttentionGraph key={experiment.enabled ? 'experiment' : 'normal'} store={attentionStore} playback={player} variant="compact" refreshMs={1000} onSeek={seekGraph} />
            <button className="button button--outline button--small" disabled={!timeline.videoId} onClick={() => setShowSummary((value) => !value)}>{showSummary ? 'Hide attention summary' : timeline.completed ? 'Attention summary (saved)' : 'Attention summary'}</button>
            {!experiment.enabled && client.kind === 'synthetic' && <AttentionDemoPanel store={attentionStore} playback={player} />}
            {!experiment.enabled && reminders.length > 0 && <section className="reminder-stack" aria-label="Review reminders" data-testid="reminder-stack">
              <h2>Heads-up <span className="count-badge">{reminders.length}</span></h2>
              <div className="reminder-stack__items">
                {reminders.map((bookmark) => <article className="reminder-notice" key={bookmark.bookmarkId} data-testid="review-reminder" role="status">
                  <strong>Review moment saved at {formatTime(bookmark.suggestedMediaS)}</strong>
                  <p>{bookmark.runKind === 'simulated' ? 'Simulated reminder.' : bookmark.source === 'experimental_combined' ? 'Your EEG and calibrated gaze suggested this moment.' : 'Your EEG signal suggested this moment.'} Watch on, or revisit it when you’re ready.</p>
                  <button type="button" className="button button--primary button--small" onClick={() => replay(bookmark)}>Replay</button>
                  <button type="button" className="button button--quiet button--small" aria-label={`Close reminder at ${formatTime(bookmark.suggestedMediaS)}`} onClick={() => setReminders((saved) => saved.filter((b) => b.bookmarkId !== bookmark.bookmarkId))}>Close</button>
                </article>)}
              </div>
            </section>}

            <section className="review-panel" aria-labelledby="review-title">
              <div className="section-heading">
                <h2 id="review-title">{ended || focus.snapshot?.ended ? 'End-of-lecture bookmarks' : 'Review moments'} <span className="count-badge" data-testid="bookmark-count-badge">{activeBookmarks.length}</span></h2>
              </div>
              <p className="review-intro">
                Moments are suggestions to review, not judgments about your attention. Nothing pauses or rewinds on its own.
              </p>
              {(ended || focus.snapshot?.ended) && <p role="status">Lecture complete. Choose a saved flag to revisit a moment.</p>}
              {!experiment.enabled && snapshot.sensors && !snapshot.sensors.automaticSuggestions && (
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
                  <strong>No review moments yet</strong>
                  <p>Start the lecture to receive suggestions, or add a marker at any moment.</p>
                  {!lecture && <span className="review-empty__hint">Your moments will appear here.</span>}
                </div>
              )}
            </section>

            {!experiment.enabled && focus.notice && !ended && !focus.snapshot?.ended && <section className="focus-tools" role="status" aria-label="Focus heads-up">
              <strong>Heads-up: review moment saved</strong>
              <p>You may want to revisit {formatTime(focus.notice.mediaRange.startMediaS)} when you’re ready.</p>
              <button onClick={() => { const bookmark = focus.moments.find((b) => b.suggestedMediaS === focus.notice!.mediaRange.startMediaS); if (bookmark) replay(bookmark); }}>Replay saved moment</button>
              <button onClick={focus.closeNotice}>Close heads-up</button>
            </section>}

          </aside>
        </div>
      </main>

      <SessionSetup open={setupOpen} onClose={() => setSetupOpen(false)} snapshot={snapshot} lecture={lecture}
        player={player} focus={focus} attention={personalAttention} experiment={experiment}
        devices={<DeviceStatus clientKind={snapshot.kind} sensors={snapshot.sensors} />} />

      <footer className="page-footer">
        <span>ReMind</span>
        <span>Learning, at your pace. Experimental signals are not validated attention measurements.</span>
      </footer>
    </div>
  );
}
