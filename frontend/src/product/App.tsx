import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { AlertIcon, ChevronRightIcon, CloseIcon, EyeIcon, FilmIcon, FlagIcon, ReplayIcon, SettingsIcon, ActivityIcon, ThumbsDownIcon, ThumbsUpIcon, UndoIcon, CheckIcon } from '../ui/icons';
import { planReplay } from './replayPlan';
import { useFocusReview } from '../focus/useFocusReview';
import { SessionSetup } from './SessionSetup';
import './product.css'; // last: must load after the player, transcript and focus styles it refines
import './brutal.css'; // variation B, applied only with ?design=brutal

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

type PanelTab = 'transcript' | 'moments' | 'attention';

const SENSOR_TONE = { ok: 'good', lost: 'warn', unavailable: 'muted' } as const;
function sensorSummary(state: SensorState['state'] | undefined, kind: 'eeg' | 'gaze'): { label: string; tone: 'good' | 'warn' | 'muted' } {
  if (!state) return { label: 'Waiting', tone: 'muted' };
  if (state === 'ok') return { label: kind === 'eeg' ? 'Receiving' : 'Tracking', tone: 'good' };
  if (state === 'unavailable') return { label: 'Not set up', tone: 'muted' };
  return { label: statusLabel(state), tone: SENSOR_TONE[state as keyof typeof SENSOR_TONE] ?? 'muted' };
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
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(timer);
  }, [note]);
  const at = formatTime(bookmark.suggestedMediaS);
  const replayFrom = formatTime(passage ? passage.startS : bookmark.suggestedMediaS);

  return (
    <article className={`bookmark-card moment${dismissed ? ' bookmark-card--dismissed' : ''}`}>
      <time className="moment__time" dateTime={`PT${bookmark.suggestedMediaS}S`}>{at}</time>
      <div className="moment__body">
        <p className="moment__meta">
          <span className="chip">{sourceLabel(bookmark.source)}</span>
          {earlierCount > 0 && <span>Moved earlier {earlierCount}×</span>}
          {passage && earlierCount === 0 && <span>Replays from {replayFrom}</span>}
        </p>
        <h3 className="moment__text">{passage?.text ?? 'Review this moment'}</h3>
        {dismissed ? (
          <p className="moment__note" role="status">Dismissed for this view</p>
        ) : (
          <>
            <div className="moment__actions">
              <button className="btn btn--primary btn--sm" type="button" onClick={() => { onReplay(bookmark); setNote(`Replaying from ${replayFrom}`); }}>
                <ReplayIcon /> Replay
              </button>
              <div className="moment__tools">
                {passage && (
                  <button className="btn btn--icon" type="button" onClick={() => { onEarlier(bookmark); setNote('Replay now starts one passage earlier'); }}
                    disabled={passage.index === 0} aria-label={`Move replay earlier for ${at}`} title="Start one passage earlier">
                    <UndoIcon />
                  </button>
                )}
                <button className="btn btn--icon" type="button" onClick={() => onDismiss(bookmark)} aria-label="Dismiss" title="Dismiss">
                  <CloseIcon />
                </button>
                <span className="moment__rule" aria-hidden="true" />
                {rated ? null : (
                  <span role="group" aria-label="Was this suggestion helpful?" className="moment__rate">
                    <button className="btn btn--icon" type="button" aria-label="Mark suggestion useful" title="Helpful" onClick={() => { setRated('useful'); onRate(bookmark, true); }}>
                      <ThumbsUpIcon />
                    </button>
                    <button className="btn btn--icon" type="button" aria-label="Mark suggestion not useful" title="Not helpful" onClick={() => { setRated('not_useful'); onRate(bookmark, false); }}>
                      <ThumbsDownIcon />
                    </button>
                  </span>
                )}
              </div>
            </div>
            {(rated || note) && (
              <p className="moment__note" role="status">
                <CheckIcon /> {rated ? 'Thanks, noted.' : note}
              </p>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function SensorRow({ icon, name, summary }: { icon: ReactNode; name: string; summary: { label: string; tone: string } }) {
  return (
    <div className="device-row">
      <span className="device-row__name">{icon}{name}</span>
      <span className={`device-state device-state--${summary.tone}`}><span className="status-dot" />{summary.label}</span>
    </div>
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
          const state = sensors?.[name]?.state;
          const tone = state === 'ok' ? 'good' : state === 'lost' || state === 'unavailable' ? 'muted' : 'waiting';
          return (
            <div className="device-row" key={name}>
              <span className="device-row__name">{name === 'eeg' ? <ActivityIcon /> : <EyeIcon />}{sensorLabels[name]}</span>
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
  const [importTarget, setImportTarget] = useState<HTMLDivElement | null>(null);
  const [transcriptFileTarget, setTranscriptFileTarget] = useState<HTMLDivElement | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('moments');
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
  const [attentionStore] = useState(() => new AttentionTimelineStore());
  const [viewMode, setViewMode] = useState<PlayerViewMode>('normal');
  const [showSummary, setShowSummary] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() => new URLSearchParams(window.location.search).get('setup') === '1');
  const timeline = useTimeline(attentionStore);
  useAttentionLecture(attentionStore, player);
  const personalAttention = usePersonalAttention(client, snapshot.session?.sessionId, lecture?.videoId, attentionStore);

  useEffect(() => client.onEvent((event) => {
    if (event.type === 'session_started' || event.type === 'session_ended') setReminders([]);
    if (event.type === 'bookmark_added' && event.bookmark.source !== 'manual') {
      setReminders((saved) => saved.some((b) => b.bookmarkId === event.bookmark.bookmarkId)
        ? saved : [...saved, event.bookmark]);
    }
  }), [client]);

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
    () => [...snapshot.bookmarks.filter((bookmark) => (!lecture || bookmark.videoId === lecture.videoId) && (client.kind === 'live' || !focus.enabled || bookmark.source === 'manual')), ...focus.moments]
      .sort((a, b) => a.suggestedMediaS - b.suggestedMediaS),
    [snapshot.bookmarks, lecture, focus.enabled, focus.moments, client],
  );

  useEffect(() => {
    if (!lecture) return;
    for (const bookmark of activeBookmarks) attentionStore.addMarker(markerFromBookmark({ ...bookmark, runKind: client.kind === 'synthetic' ? 'simulated' : 'live' }));
  }, [activeBookmarks, lecture, attentionStore, client]);
  useEffect(() => {
    if (client.kind !== 'synthetic' || !focus.snapshot || !player) return;
    const observation = observationFromEvaluation(focus.snapshot, player.getState());
    if (observation) attentionStore.record({ ...observation, origin: 'simulated' });
  }, [focus.snapshot, client, player, attentionStore]);
  useEffect(() => { if (ended) { setShowSummary(true); setPanelTab('attention'); } }, [ended]);
  useEffect(() => { if (transcript) setPanelTab('transcript'); }, [transcript]);
  useEffect(() => { setShowSummary(false); }, [lecture?.videoId]);

  const onLectureChange = (next: LoadedLecture | null) => {
    setLecture(next);
    setPanelTab('moments');
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
  const connectionLabel = connection.state === 'connected'
    ? snapshot.kind === 'synthetic' ? 'Simulation ready' : 'Session connected'
    : connection.state === 'connecting' || connection.state === 'reconnecting'
      ? 'Connecting'
      : connection.state === 'pairing_required'
        ? 'Pairing needed'
        : connection.state === 'incompatible'
          ? 'Version mismatch'
          : snapshot.kind === 'synthetic' ? 'Simulation stopped' : 'Not connected';
  const eegSummary = sensorSummary(snapshot.sensors?.eeg?.state, 'eeg');
  const gazeSummary = sensorSummary(snapshot.sensors?.gaze?.state, 'gaze');
  const trackingTone = eegSummary.tone === 'good' && gazeSummary.tone === 'good' ? 'good' : eegSummary.tone === 'good' || gazeSummary.tone === 'good' ? 'part' : 'off';
  const testEeg = snapshot.kind === 'live' && snapshot.session?.config.eegDevice?.model?.startsWith('Scripted test EEG');
  const complete = ended || focus.snapshot?.ended;
  const design = useMemo(() => (new URLSearchParams(window.location.search).get('design') === 'brutal' ? 'brutal' : undefined), []);
  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: 'transcript', label: 'Transcript' },
    { id: 'moments', label: 'Moments', count: activeBookmarks.length },
    { id: 'attention', label: 'Attention' },
  ];

  const headsUp = (reminders.length > 0 || (focus.notice && !complete)) && (
    <section className="headsup" aria-label="Review reminders" data-testid="reminder-stack">
      {reminders.map((bookmark) => (
        <article className="headsup__item glass" key={bookmark.bookmarkId} data-testid="review-reminder" role="status">
          <span className="headsup__mark" aria-hidden="true"><FlagIcon /></span>
          <div className="headsup__text">
            <strong>Review moment saved at {formatTime(bookmark.suggestedMediaS)}</strong>
            <span>{bookmark.runKind === 'simulated' ? 'Simulated reminder.' : bookmark.source === 'experimental_combined' ? 'Your EEG and calibrated gaze suggested it.' : 'Your EEG signal suggested it.'}</span>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => replay(bookmark)}>Replay</button>
          <button type="button" className="btn btn--glass-icon" aria-label={`Close reminder at ${formatTime(bookmark.suggestedMediaS)}`}
            onClick={() => setReminders((saved) => saved.filter((b) => b.bookmarkId !== bookmark.bookmarkId))}><CloseIcon /></button>
        </article>
      ))}
      {focus.notice && !complete && (
        <article className="headsup__item glass focus-tools" role="status" aria-label="Focus heads-up">
          <span className="headsup__mark" aria-hidden="true"><FlagIcon /></span>
          <div className="headsup__text">
            <strong>Heads-up: review moment saved</strong>
            <span>You may want to revisit {formatTime(focus.notice.mediaRange.startMediaS)} when you’re ready.</span>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => { const bookmark = focus.moments.find((b) => b.suggestedMediaS === focus.notice!.mediaRange.startMediaS); if (bookmark) replay(bookmark); }}>Replay saved moment</button>
          <button type="button" className="btn btn--glass-icon" aria-label="Close heads-up" onClick={focus.closeNotice}><CloseIcon /></button>
        </article>
      )}
    </section>
  );

  return (
    <div className={`app-shell app-shell--${lecture ? 'loaded' : 'empty'}`} data-design={design}>
      <header className="topbar glass-bar">
        <a className="brand" href="/" aria-label="ReMind home">
          <Wordmark />
        </a>
        <div className="topbar__right">
          <span className={`connection-pill connection-pill--${connectionTone}`} role="status">
            <span className="status-dot" />
            {connectionLabel}
          </span>
          <button className="btn btn--soft setup-trigger" type="button" onClick={() => setSetupOpen(true)}>
            <SettingsIcon />
            <span className="setup-trigger__label">Session setup</span>
            <span className={`tracking-dot tracking-dot--${trackingTone}`} aria-hidden="true" />
          </button>
        </div>
      </header>

      <h1 className="sr-only">ReMind lecture review</h1>

      <main className="workspace" data-view={viewMode} data-state={lecture ? 'loaded' : 'empty'}>
        <div className="notices">
          {snapshot.kind === 'synthetic' && (
            <div className="notice notice--info" role="status">
              <AlertIcon />
              <p><strong>Simulation mode.</strong> Suggestions and device states are simulated, not real attention measurements.</p>
            </div>
          )}
          {testEeg && (
            <div className="notice notice--info" role="status" data-testid="test-eeg-banner">
              <AlertIcon />
              <p>
                <strong>Test EEG + real webcam.</strong> The EEG scores are scripted for rehearsal. No headset is connected, so
                nothing here reflects your brain activity. Gaze, if you enable it, comes from your own camera.
              </p>
            </div>
          )}
          {connection.state !== 'connected' && connection.state !== 'idle' && (
            <div className={`notice notice--${connectionTone === 'attention' ? 'warn' : 'info'}`} role="status">
              <AlertIcon />
              <p>
                <strong>
                  {connection.state === 'pairing_required' ? 'Connect to your session.' :
                    connection.state === 'incompatible' ? 'Update needed.' :
                      connection.state === 'reconnecting' ? 'Connection interrupted.' :
                        connection.state === 'closed' ? 'Session disconnected.' : 'Connecting to session.'}
                </strong>{' '}
                {connection.detail}
              </p>
            </div>
          )}
          {replayError && (
            <div className="notice notice--warn" role="alert" data-testid="replay-error">
              <AlertIcon />
              <p><strong>Replay.</strong> {replayError}</p>
            </div>
          )}
          {snapshot.errors.length > 0 && (
            <div className="notice notice--warn" role="alert">
              <AlertIcon />
              <p><strong>Session message.</strong> {snapshot.errors[snapshot.errors.length - 1]?.message}</p>
            </div>
          )}
        </div>

        <section className="stage-column" aria-label="Lecture video">
          <div className="stage-toolbar" hidden={!lecture}>
            <div className="stage-title">
              <strong title={lecture?.fileName}>{lecture?.fileName}</strong>
              <span>{duration ? `${formatTime(duration)} · local video, never uploaded` : 'Local video, never uploaded'}</span>
            </div>
            <div className="stage-actions">
              <button
                className="btn btn--soft"
                type="button"
                disabled={!snapshot.session || !lecture}
                title={snapshot.session ? 'Add a review marker at the current time' : 'Waiting for an active session'}
                onClick={() => client.markBookmark(currentTime)}
                aria-label={`Mark this moment at ${formatTime(currentTime)}`}
              >
                <FlagIcon /> Mark moment
              </button>
              <div ref={setLectureFileTarget} className="file-slot" role="group" aria-label="Lecture file" />
            </div>
          </div>

          <LecturePlayer client={client} session={sessionSettings} ref={setPlayer} onLectureChange={onLectureChange}
            filePickerTarget={lecture ? lectureFileTarget : importTarget}
            viewMode={viewMode} onViewModeChange={setViewMode}
            emptyState={(
              <div className="import">
                <span className="import__icon" aria-hidden="true"><FilmIcon /></span>
                <h2>Open a lecture</h2>
                <p>Choose a video from this device. It plays right here and is never uploaded.</p>
                <div ref={setImportTarget} className="import__action" />
                <span className="import__hint">or drop a video anywhere on this card · MP4, WebM or MOV</span>
                <div className="import__tracking">
                  <div className="import__tracking-rows">
                    <SensorRow icon={<EyeIcon />} name="Eye tracking" summary={gazeSummary} />
                    <SensorRow icon={<ActivityIcon />} name="EEG" summary={eegSummary} />
                  </div>
                  <button className="btn btn--quiet btn--sm" type="button" onClick={() => setSetupOpen(true)}>
                    Set up <ChevronRightIcon />
                  </button>
                </div>
              </div>
            )}
            overlay={<>
              <AttentionInfoIndicator store={attentionStore} onSeek={seekAttention} />
              {headsUp}
            </>} />

          {activeBookmarks.length > 0 && <nav aria-label="Saved bookmark flags" className="moment-rail">
            <h2 className="moment-rail__label">{complete ? 'End-of-lecture bookmarks' : 'Saved moments'}</h2>
            {activeBookmarks.map((bookmark) => <button className="btn btn--flag btn--sm" key={bookmark.bookmarkId} onClick={() => replay(bookmark)} aria-label={`Replay bookmark at ${formatTime(bookmark.suggestedMediaS)}`}>
              <FlagIcon />{formatTime(bookmark.suggestedMediaS)}
            </button>)}
          </nav>}
        </section>

        {lecture && (
          <aside className="side-panel" aria-label="Transcript, moments and attention">
            <div className="tabs" role="tablist" aria-label="Lecture panel">
              {tabs.map((tab) => (
                <button key={tab.id} role="tab" type="button" id={`tab-${tab.id}`} aria-selected={panelTab === tab.id} aria-controls={`panel-${tab.id}`}
                  tabIndex={panelTab === tab.id ? 0 : -1} className="tab" onClick={() => setPanelTab(tab.id)}
                  onKeyDown={(event) => {
                    const index = tabs.findIndex((t) => t.id === tab.id);
                    const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : null;
                    if (next) { event.preventDefault(); setPanelTab(next.id); document.getElementById(`tab-${next.id}`)?.focus(); }
                  }}>
                  {tab.label}
                  {tab.count !== undefined && tab.count > 0 && <span className="count-badge" data-testid={tab.id === 'moments' ? 'bookmark-count-badge' : undefined}>{tab.count}</span>}
                </button>
              ))}
            </div>

            <div className="tabpanel" role="tabpanel" id="panel-transcript" aria-labelledby="tab-transcript" hidden={panelTab !== 'transcript'}>
              <div ref={setTranscriptFileTarget} className="file-slot file-slot--panel" role="group" aria-label="Transcript file" />
              {/* key: a new lecture starts without the previous lecture's transcript */}
              <TranscriptPanel key={lecture?.videoId ?? 'none'} player={player} onTranscriptChange={setTranscript} filePickerTarget={transcriptFileTarget} />
            </div>

            <div className="tabpanel" role="tabpanel" id="panel-moments" aria-labelledby="tab-moments" hidden={panelTab !== 'moments'}>
              <p className="panel-lede">
                {complete ? 'Lecture complete. Choose a moment to revisit it.' : 'Suggestions to review, not judgments about your attention. Nothing pauses or rewinds on its own.'}
              </p>
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
                  <span className="review-empty__icon" aria-hidden="true"><FlagIcon /></span>
                  <strong>No review moments yet</strong>
                  <p>Mark a moment while you watch, or let a suggestion appear.</p>
                </div>
              )}
              {snapshot.session?.config.detector?.detectorId.startsWith('experimental-live-eeg') && (
                <details className="info-disclosure">
                  <summary>About EEG reminders</summary>
                  <p>Experimental. Calibrate your personal baseline before watching. Reminders follow 8 seconds of sustained low model estimates after smoothing, with a 30-second cooldown. Model estimates are not validated attention measurements.</p>
                </details>
              )}
            </div>

            <div className="tabpanel" role="tabpanel" id="panel-attention" aria-labelledby="tab-attention" hidden={panelTab !== 'attention'}>
              <AttentionGraph store={attentionStore} playback={player} variant="compact" refreshMs={1000} onSeek={seekGraph} />
              <button className="btn btn--soft btn--block" type="button" disabled={!timeline.videoId} onClick={() => setShowSummary((value) => !value)}>
                {showSummary ? 'Hide attention summary' : timeline.completed ? 'Attention summary (saved)' : 'Attention summary'}
              </button>
              {showSummary && <AttentionSummary store={attentionStore} playback={player} onSeek={seekGraph} onClose={() => setShowSummary(false)} />}
              {client.kind === 'synthetic' && <AttentionDemoPanel store={attentionStore} playback={player} />}
            </div>
          </aside>
        )}
      </main>

      <SessionSetup open={setupOpen} onClose={() => setSetupOpen(false)} snapshot={snapshot} lecture={lecture}
        player={player} focus={focus} attention={personalAttention}
        devices={<DeviceStatus clientKind={snapshot.kind} sensors={snapshot.sensors} />} />

      <footer className="page-footer">
        <span>Experimental EEG and gaze signals are not validated attention measurements.</span>
      </footer>
    </div>
  );
}
