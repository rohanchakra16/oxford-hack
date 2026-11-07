import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  attachMediaElement,
  createReviewClient,
  useReviewConnection,
  useReviewSnapshot,
  type ReviewBookmark,
  type ReviewClient,
  type SensorState,
} from '../integration';
import { formatTime, parseTranscript, replayPassage, type TranscriptCue } from './transcript';
import './product.css';

interface LocalVideo {
  file: File;
  id: string;
  url: string;
}

const sensorLabels = { eeg: 'EEG headset', gaze: 'Webcam gaze' } as const;

function getVideoId(file: File): string {
  return `local-${encodeURIComponent(file.name)}-${file.size}-${file.lastModified}`;
}

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

function BookmarkCard({
  bookmark,
  cues,
  dismissed,
  earlierCount,
  onReplay,
  onDismiss,
  onEarlier,
  onRate,
}: {
  bookmark: ReviewBookmark;
  cues: TranscriptCue[];
  dismissed: boolean;
  earlierCount: number;
  onReplay: (bookmark: ReviewBookmark) => void;
  onDismiss: (bookmark: ReviewBookmark) => void;
  onEarlier: (bookmark: ReviewBookmark) => void;
  onRate: (bookmark: ReviewBookmark, useful: boolean) => void;
}) {
  const passage = replayPassage(cues, bookmark.suggestedMediaS, earlierCount);

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
  const [video, setVideo] = useState<LocalVideo | null>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [transcriptName, setTranscriptName] = useState('');
  const [cues, setCues] = useState<TranscriptCue[]>([]);
  const [transcriptError, setTranscriptError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [earlierCounts, setEarlierCounts] = useState<Record<string, number>>({});
  const [playbackError, setPlaybackError] = useState('');
  const videoInputRef = useRef<HTMLInputElement>(null);
  const transcriptInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => client.dispose(), [client]);

  useEffect(() => {
    if (!video) return;
    return () => URL.revokeObjectURL(video.url);
  }, [video]);

  useEffect(() => {
    if (!videoElement) return;
    const detach = attachMediaElement(client, videoElement);
    return detach;
  }, [client, videoElement]);

  useEffect(() => {
    if (!video || !videoElement) return;
    client.startSession({
      videoId: video.id,
      runKind: client.kind === 'synthetic' ? 'simulated' : 'live',
      sensors: { eeg: true, gaze: true },
      mediaDurationS: Number.isFinite(videoElement.duration) ? videoElement.duration : null,
    });
    return () => client.endSession('video_changed');
  }, [client, video, videoElement]);

  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    setVideoElement(element);
  }, []);

  const activeBookmarks = useMemo(
    () => snapshot.bookmarks.filter((bookmark) => !video || bookmark.videoId === video.id),
    [snapshot.bookmarks, video],
  );

  const chooseVideo = (file?: File) => {
    if (!file) return;
    if (video && videoElement) {
      client.reportMediaEvent('emptied', {
        currentTime: videoElement.currentTime,
        playbackRate: videoElement.playbackRate,
        duration: videoElement.duration,
        paused: videoElement.paused,
        seeking: videoElement.seeking,
        ended: videoElement.ended,
        readyState: videoElement.readyState,
      });
    }
    setPlaybackError('');
    setCurrentTime(0);
    setDuration(0);
    setDismissed(new Set());
    setEarlierCounts({});
    setCues([]);
    setTranscriptName('');
    setTranscriptError('');
    setVideo({ file, id: getVideoId(file), url: URL.createObjectURL(file) });
  };

  const chooseTranscript = async (file?: File) => {
    if (!file) return;
    setTranscriptError('');
    try {
      const parsed = parseTranscript(await file.text());
      if (parsed.length === 0) {
        setTranscriptError('No timestamped captions found. Try a WebVTT or SRT file.');
        return;
      }
      setCues(parsed);
      setTranscriptName(file.name);
    } catch (error) {
      setTranscriptError(error instanceof Error ? error.message : 'Could not read this transcript.');
    }
  };

  const replay = (bookmark: ReviewBookmark) => {
    const count = earlierCounts[bookmark.bookmarkId] ?? 0;
    const passage = replayPassage(cues, bookmark.suggestedMediaS, count);
    const target = passage?.startS ?? bookmark.suggestedMediaS;
    if (videoElement) {
      videoElement.currentTime = target;
      setPlaybackError('');
      void videoElement.play().catch(() => {
        setPlaybackError('Playback could not start. Press play on the video to continue.');
      });
    }
    client.sendFeedback(bookmark.bookmarkId, 'replay', target);
  };

  const dismiss = (bookmark: ReviewBookmark) => {
    client.sendFeedback(bookmark.bookmarkId, 'dismiss', currentTime);
    setDismissed((previous) => new Set(previous).add(bookmark.bookmarkId));
  };

  const moveEarlier = (bookmark: ReviewBookmark) => {
    const count = (earlierCounts[bookmark.bookmarkId] ?? 0) + 1;
    setEarlierCounts((previous) => ({ ...previous, [bookmark.bookmarkId]: count }));
    const target = replayPassage(cues, bookmark.suggestedMediaS, count)?.startS ?? bookmark.suggestedMediaS;
    client.sendFeedback(bookmark.bookmarkId, 'move_earlier', target);
  };

  const rate = (bookmark: ReviewBookmark, useful: boolean) => {
    client.sendFeedback(bookmark.bookmarkId, useful ? 'rated_useful' : 'rated_not_useful', currentTime);
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
              {video ? (
                <>
                  <div className="video-wrap">
                    <video
                      ref={videoRef}
                      src={video.url}
                      controls
                      playsInline
                      preload="metadata"
                      aria-label={`Lecture video: ${video.file.name}`}
                      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                      onLoadedMetadata={(event) => {
                        const mediaDuration = event.currentTarget.duration;
                        setDuration(Number.isFinite(mediaDuration) ? mediaDuration : 0);
                      }}
                      onDurationChange={(event) => {
                        const mediaDuration = event.currentTarget.duration;
                        setDuration(Number.isFinite(mediaDuration) ? mediaDuration : 0);
                      }}
                      onError={() => setPlaybackError('This video could not be opened. Try a different local video file.')}
                    />
                  </div>
                  <div className="player-card__footer">
                    <div className="lecture-file">
                      <span className="file-icon" aria-hidden="true">▶</span>
                      <div>
                        <strong title={video.file.name}>{video.file.name}</strong>
                        <span>{duration ? `${formatTime(duration)} lecture` : 'Local video'}</span>
                      </div>
                    </div>
                    <div className="player-tools">
                      <button
                        className="button button--outline button--small"
                        type="button"
                        disabled={!snapshot.session}
                        title={snapshot.session ? 'Add a review marker at the current time' : 'Waiting for an active session'}
                        onClick={() => client.markBookmark(currentTime)}
                        aria-label={`Mark this moment at ${formatTime(currentTime)}`}
                      >
                        <span aria-hidden="true">◆</span> Mark moment
                      </button>
                      <button className="text-button" type="button" onClick={() => videoInputRef.current?.click()}>
                        Change video
                      </button>
                    </div>
                  </div>
                  {playbackError && <p className="inline-error" role="alert">{playbackError}</p>}
                </>
              ) : (
                <div className="video-empty">
                  <div className="empty-art" aria-hidden="true">
                    <span className="empty-art__sun" />
                    <span className="empty-art__play">▶</span>
                    <span className="empty-art__line" />
                  </div>
                  <p className="eyebrow">Start with a lecture</p>
                  <h2>Bring your video in.</h2>
                  <p>Choose a video from your device. It stays in this browser session.</p>
                  <button className="button button--primary" type="button" onClick={() => videoInputRef.current?.click()}>
                    Choose a video <span aria-hidden="true">↗</span>
                  </button>
                  <span className="supported-format">MP4, WebM, or another browser-supported format</span>
                </div>
              )}
              <input
                ref={videoInputRef}
                className="sr-only"
                type="file"
                accept="video/*"
                aria-label="Choose a local lecture video"
                onChange={(event) => {
                  chooseVideo(event.currentTarget.files?.[0]);
                  event.currentTarget.value = '';
                }}
              />
            </section>

            <section className="transcript-card" aria-labelledby="transcript-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Follow along</p>
                  <h2 id="transcript-title">Transcript</h2>
                </div>
                <button className="button button--outline button--small" type="button" onClick={() => transcriptInputRef.current?.click()}>
                  {transcriptName ? 'Replace file' : 'Add captions'}
                </button>
                <input
                  ref={transcriptInputRef}
                  className="sr-only"
                  type="file"
                  accept=".vtt,.srt,text/vtt,application/x-subrip"
                  aria-label="Choose a WebVTT or SRT transcript"
                  onChange={(event) => {
                    void chooseTranscript(event.currentTarget.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </div>
              {transcriptError && <p className="inline-error" role="alert">{transcriptError}</p>}
              {cues.length > 0 ? (
                <>
                  <p className="transcript-file">{transcriptName} · Select a caption to jump to that passage.</p>
                  <div className="transcript-list" aria-label="Transcript passages">
                    {cues.map((cue, index) => {
                      const active = currentTime >= cue.startS && currentTime <= cue.endS;
                      return (
                        <button
                          className={`transcript-line${active ? ' transcript-line--active' : ''}`}
                          type="button"
                          key={`${cue.startS}-${index}`}
                          onClick={() => {
                            if (videoElement) videoElement.currentTime = cue.startS;
                          }}
                          aria-current={active ? 'true' : undefined}
                        >
                          <time>{formatTime(cue.startS)}</time>
                          <span>{cue.text}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="transcript-empty">
                  <span className="transcript-empty__icon" aria-hidden="true">Aa</span>
                  <div>
                    <strong>{transcriptError ? 'Transcript unavailable' : 'No transcript added yet'}</strong>
                    <p>Add a timed WebVTT or SRT file to navigate and replay captioned passages.</p>
                  </div>
                </div>
              )}
            </section>
          </div>

          <aside className="side-column" aria-label="Session and review">
            <DeviceStatus clientKind={snapshot.kind} sensors={snapshot.sensors} />

            <section className="review-panel" aria-labelledby="review-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Your checkpoints</p>
                  <h2 id="review-title">Review moments <span className="count-badge">{activeBookmarks.length}</span></h2>
                </div>
              </div>
              <p className="review-intro">
                Moments are suggestions to review, not judgments about your attention.
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
                      cues={cues}
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
                  {!video && <span className="review-empty__hint">Your moments will appear here.</span>}
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
