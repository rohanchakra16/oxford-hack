/**
 * LecturePlayer: open a local lecture video, play it, forward playback telemetry,
 * and expose a PlayerHandle (state, seek, replayRange) to the rest of the app.
 * Owner: Person 4 (@aryanmorarji). See src/player/README.md.
 */
import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { attachMediaElement, type ReviewClient, type StartSessionOptions } from '../integration';
import { PlayerController, type ObservedEvent, type PlaybackStatus } from './controller';
import { checkVideoFile, describeMediaError, formatMediaTime, localVideoId } from './localMedia';
import './player.css';

/** What other components (review UI, transcript, dev harness) may use. Times are media seconds. */
export interface PlayerHandle {
  getState(): PlaybackStatus;
  subscribe(listener: () => void): () => void;
  /** Raw media events, for logging/diagnostics only. */
  onMediaEvent(listener: (event: ObservedEvent, status: PlaybackStatus) => void): () => void;
  play(): Promise<void>;
  pause(): void;
  seek(timeS: number): void;
  replayRange(startS: number, endS: number): Promise<void>;
  cancelReplay(): void;
  /** The currently loaded lecture, or null. */
  getLecture(): LoadedLecture | null;
  /**
   * The <video> element, for gaze geometry (read its rect; do not control playback through it,
   * use seek/play/pause above). Same element for the player's lifetime. Styled object-fit: contain,
   * centred, with no padding or border; changes will be announced on the board (#1).
   */
  getVideoElement(): HTMLVideoElement;
}

export interface LoadedLecture {
  videoId: string;
  fileName: string;
}

export type LoadState =
  | { kind: 'empty' }
  | { kind: 'loading'; fileName: string }
  | { kind: 'ready'; fileName: string }
  | { kind: 'error'; message: string };

/**
 * Layout mode. `minimised` only makes the player compact; where it is docked (e.g. beside the
 * sidebar) is the composition's decision. `maximised` fills the window. True fullscreen is separate
 * (browser Fullscreen API) and can be entered from any mode.
 */
export type PlayerViewMode = 'normal' | 'minimised' | 'maximised';

export interface LecturePlayerProps {
  client: ReviewClient;
  /** Session settings passed to client.startSession. Composition (Betty) decides these. */
  session?: Pick<StartSessionOptions, 'runKind' | 'sensors'>;
  ref?: Ref<PlayerHandle | null>;
  /** Called when a lecture is loaded or cleared. */
  onLectureChange?: (lecture: LoadedLecture | null) => void;
  /** Optional shared file toolbar. Loading and session state stay owned by this player. */
  filePickerTarget?: HTMLElement | null;
  /** Controlled view mode. Omit to let the player manage it (starts at `defaultViewMode`). */
  viewMode?: PlayerViewMode;
  defaultViewMode?: PlayerViewMode;
  onViewModeChange?: (mode: PlayerViewMode) => void;
  /** Called when true fullscreen is entered or left. */
  onFullscreenChange?: (fullscreen: boolean) => void;
  /**
   * Content layered over the video stage (e.g. the attention ⓘ indicator). It is inside the
   * element that goes fullscreen, so it stays anchored to the video in every mode. The slot itself
   * does not take pointer events; children opt in with `pointer-events: auto`.
   */
  overlay?: ReactNode;
  /** Replaces the default "no lecture" message while no lecture is open (the composition's import state). */
  emptyState?: ReactNode;
}

const DEFAULT_SESSION: Pick<StartSessionOptions, 'runKind' | 'sensors'> = {
  runKind: 'live',
  sensors: { eeg: true, gaze: true },
};
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const NOOP_SUBSCRIBE = () => () => {};

type PlayerIconName = 'play' | 'pause' | 'volume' | 'muted' | 'minimise' | 'maximise' | 'restore' | 'fullscreen' | 'exit-fullscreen';

function PlayerIcon({ name }: { name: PlayerIconName }) {
  const paths: Record<PlayerIconName, ReactNode> = {
    play: <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
    pause: <path d="M8 5v14M16 5v14" strokeWidth="3.5" />,
    volume: <><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    muted: <><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="m16 9 6 6m0-6-6 6" /></>,
    minimise: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 12h6v4h-6Z" fill="currentColor" stroke="none" /></>,
    maximise: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /></>,
    restore: <><path d="M8 4h12v12M4 8h12v12H4Z" /></>,
    fullscreen: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    'exit-fullscreen': <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5" />,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

const rangeFill = (value: number): CSSProperties => ({ '--lp-fill': `${Math.max(0, Math.min(100, value))}%` }) as CSSProperties;

export function LecturePlayer({
  client,
  session = DEFAULT_SESSION,
  ref,
  onLectureChange,
  filePickerTarget,
  viewMode,
  defaultViewMode = 'normal',
  onViewModeChange,
  onFullscreenChange,
  overlay,
  emptyState,
}: LecturePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const [ownMode, setOwnMode] = useState<PlayerViewMode>(defaultViewMode);
  const mode = viewMode ?? ownMode;
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const onViewModeChangeRef = useRef(onViewModeChange);
  onViewModeChangeRef.current = onViewModeChange;
  const onFullscreenChangeRef = useRef(onFullscreenChange);
  onFullscreenChangeRef.current = onFullscreenChange;
  const setMode = (next: PlayerViewMode) => {
    if (viewMode === undefined) setOwnMode(next);
    onViewModeChangeRef.current?.(next);
  };
  /** The element the current controller was built on (set together with the controller). */
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const [controller, setController] = useState<PlayerController | null>(null);
  const [lecture, setLecture] = useState<(LoadedLecture & { url: string }) | null>(null);
  const [load, setLoad] = useState<LoadState>({ kind: 'empty' });
  const lectureRef = useRef(lecture);
  lectureRef.current = lecture;
  const onLectureChangeRef = useRef(onLectureChange);
  onLectureChangeRef.current = onLectureChange;

  // One controller + one telemetry attachment per mounted <video>.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const c = new PlayerController(el);
    videoElementRef.current = el;
    const detachTelemetry = attachMediaElement(client, el, () => c.getState().replay !== null);
    setController(c);
    return () => {
      detachTelemetry();
      c.dispose();
      setController(null);
    };
  }, [client]);

  // End the session and release the object URL when the player goes away.
  useEffect(() => {
    return () => {
      const current = lectureRef.current;
      if (current) {
        client.endSession('page_closing');
        URL.revokeObjectURL(current.url);
      }
    };
  }, [client]);

  // Track true fullscreen (entered via the button, left via the button, Esc or the browser).
  useEffect(() => {
    const onChange = () => {
      const on = document.fullscreenElement === rootRef.current && rootRef.current !== null;
      setFullscreen(on);
      onFullscreenChangeRef.current?.(on);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Esc leaves the maximised layout (overlays that handle Esc themselves stop propagation first).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (mode !== 'maximised' || fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && modeRef.current === 'maximised') {
        if (viewMode === undefined) setOwnMode('normal');
        onViewModeChangeRef.current?.('normal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, fullscreen, viewMode]);

  async function toggleFullscreen() {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      /* Fullscreen refused (iframe policy / browser); the maximised mode still works. */
    }
  }

  const status = useSyncExternalStore(
    controller?.subscribe ?? NOOP_SUBSCRIBE,
    () => controller?.getState() ?? null,
    () => controller?.getState() ?? null,
  );

  useImperativeHandle<PlayerHandle | null, PlayerHandle | null>(
    ref,
    () =>
      controller && {
        getState: controller.getState,
        subscribe: controller.subscribe,
        onMediaEvent: (l) => controller.onMediaEvent(l),
        play: () => controller.play(),
        pause: () => controller.pause(),
        seek: (t) => controller.seek(t),
        replayRange: (s, e) => controller.replayRange(s, e),
        cancelReplay: () => controller.cancelReplay(),
        getLecture: () => {
          const l = lectureRef.current;
          return l && { videoId: l.videoId, fileName: l.fileName };
        },
        getVideoElement: () => videoElementRef.current!,
      },
    [controller],
  );

  async function openFile(file: File) {
    const check = checkVideoFile(file);
    if (!check.ok) {
      setLoad({ kind: 'error', message: check.reason });
      return;
    }
    const videoId = await localVideoId(file);
    const previous = lectureRef.current;
    if (previous) {
      client.endSession('video_changed');
      URL.revokeObjectURL(previous.url);
    }
    // Session first, so loadedmetadata is reported to the new session.
    client.startSession({ videoId, runKind: session.runKind, sensors: session.sensors, mediaDurationS: null });
    const next = { videoId, fileName: file.name, url: URL.createObjectURL(file) };
    lectureRef.current = next;
    setLecture(next);
    setLoad({ kind: 'loading', fileName: file.name });
    onLectureChangeRef.current?.({ videoId, fileName: file.name });
  }

  const [dragging, setDragging] = useState(false);
  const ready = load.kind === 'ready' && status !== null;
  const playing = ready && !status.paused && !status.ended;

  // Only hide fullscreen chrome during playback. Focus, hovering controls and touch keep it usable.
  const immersivePlayingRef = useRef(false);
  immersivePlayingRef.current = fullscreen && playing;
  const controlsHoveredRef = useRef(false);
  function revealControls() {
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (immersivePlayingRef.current) {
      controlsTimerRef.current = setTimeout(() => {
        if (!controlsHoveredRef.current && !controlsRef.current?.contains(document.activeElement)) {
          setControlsVisible(false);
        }
      }, 2500);
    }
  }
  useEffect(() => {
    if (!fullscreen || !playing) return;
    const timer = setTimeout(() => {
      if (!controlsHoveredRef.current && !controlsRef.current?.contains(document.activeElement)) setControlsVisible(false);
    }, 2500);
    return () => {
      clearTimeout(timer);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [fullscreen, playing]);

  const chromeVisible = !fullscreen || !playing || controlsVisible;

  const filePicker = (
    <label className="lp-open media-file-action">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        <path d="m10 11 5 3-5 3Z" />
      </svg>
      <span>Open lecture</span>
      <input
        type="file"
        accept="video/*,.mp4,.m4v,.webm,.mov,.ogv,.mkv"
        aria-label="Open lecture"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = ''; // allow re-selecting the same file
          if (file) void openFile(file);
        }}
      />
    </label>
  );

  return (
    <section
      ref={rootRef}
      className={`lp lp--${mode} lp--modern${fullscreen ? ' lp--fullscreen' : ''}${chromeVisible ? '' : ' lp--controls-hidden'}${lecture ? ' lp--loaded' : ' lp--empty'}${dragging ? ' lp--dragging' : ''}`}
      aria-label="Lecture player"
      data-view-mode={mode}
      data-fullscreen={fullscreen || undefined}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void openFile(file);
      }}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onFocusCapture={revealControls}
      onKeyDownCapture={revealControls}
    >
      {filePickerTarget ? createPortal(filePicker, filePickerTarget) : <div className="lp-toolbar">
        {filePicker}
        {lecture && (
          <span className="lp-filename" title={lecture.fileName}>
            {lecture.fileName}
          </span>
        )}
      </div>}

      <div className="lp-stage">
        <video
          ref={videoRef}
          className="lp-video"
          src={lecture?.url}
          preload="metadata"
          playsInline
          hidden={load.kind === 'empty'}
          onClick={() => ready && void controller?.togglePlay()}
          onLoadedMetadata={() => lecture && setLoad({ kind: 'ready', fileName: lecture.fileName })}
          onError={(e) => {
            if (!lecture) return; // src cleared, not a real error
            setLoad({ kind: 'error', message: describeMediaError(e.currentTarget.error?.code) });
          }}
        />
        {load.kind === 'empty' && (
          emptyState ?? <p className="lp-message">No lecture open. Choose a video file from this device; it is not uploaded.</p>
        )}
        {load.kind === 'loading' && (
          <p className="lp-message lp-overlay" role="status">
            Loading {load.fileName}…
          </p>
        )}
        {load.kind === 'error' && (
          <p className="lp-message lp-error" role="alert">
            {load.message}
          </p>
        )}
        {ready && status.buffering && (
          <p className="lp-message lp-overlay" role="status">
            Buffering…
          </p>
        )}
        {overlay !== undefined && (
          <div className="lp-overlay-slot" data-testid="player-overlay-slot">
            {overlay}
          </div>
        )}
      </div>

      <div className="lp-controls" aria-disabled={!ready} ref={controlsRef}
        onPointerEnter={() => { controlsHoveredRef.current = true; revealControls(); }}
        onPointerLeave={() => { controlsHoveredRef.current = false; revealControls(); }}
        onBlur={revealControls}
      >
        <input
          className="lp-seek"
          type="range"
          aria-label="Seek"
          min={0}
          max={status?.durationS ?? 0}
          step={0.1}
          value={ready ? status.mediaTimeS : 0}
          style={rangeFill(ready && status.durationS ? status.mediaTimeS / status.durationS * 100 : 0)}
          disabled={!ready || status.durationS === null}
          onChange={(e) => controller?.seek(Number(e.currentTarget.value))}
        />
        <div className="lp-control-row">
          <button className="lp-icon-button lp-play" type="button" disabled={!ready} onClick={() => void controller?.togglePlay()}
            aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
            <PlayerIcon name={playing ? 'pause' : 'play'} />
          </button>
          <div className="lp-volume-group">
            <button className="lp-icon-button" type="button" disabled={!ready} onClick={() => controller?.setMuted(!status?.muted)}
              aria-label={status?.muted ? 'Unmute' : 'Mute'} title={status?.muted ? 'Unmute' : 'Mute'}>
              <PlayerIcon name={status?.muted || status?.volume === 0 ? 'muted' : 'volume'} />
            </button>
            <input
              className="lp-volume"
              type="range"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={status ? (status.muted ? 0 : status.volume) : 1}
              style={rangeFill((status ? (status.muted ? 0 : status.volume) : 1) * 100)}
              disabled={!ready}
              onChange={(e) => controller?.setVolume(Number(e.currentTarget.value))}
            />
          </div>
          <span className="lp-time" aria-live="off">
            {formatMediaTime(ready ? status.mediaTimeS : null)}<span className="lp-duration"> / {formatMediaTime(ready ? status.durationS : null)}</span>
          </span>
          <label className="lp-speed">
            <span className="lp-visually-hidden">Playback speed</span>
            <select
              value={status?.playbackRate ?? 1}
              disabled={!ready}
              onChange={(e) => controller?.setPlaybackRate(Number(e.currentTarget.value))}
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          <span className="lp-view-buttons" role="group" aria-label="Player size">
            {mode !== 'minimised' && !fullscreen && (
              <button className="lp-icon-button" type="button" onClick={() => setMode('minimised')} aria-label="Minimise player" title="Minimise">
                <PlayerIcon name="minimise" />
              </button>
            )}
            {mode !== 'normal' && !fullscreen && (
              <button className="lp-icon-button" type="button" onClick={() => setMode('normal')} aria-label="Restore player size" title="Restore">
                <PlayerIcon name="restore" />
              </button>
            )}
            {mode !== 'maximised' && !fullscreen && (
              <button className="lp-icon-button" type="button" onClick={() => setMode('maximised')} aria-label="Maximise player" title="Maximise">
                <PlayerIcon name="maximise" />
              </button>
            )}
            <button
              className="lp-icon-button"
              type="button"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-pressed={fullscreen}
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              <PlayerIcon name={fullscreen ? 'exit-fullscreen' : 'fullscreen'} />
            </button>
          </span>
        </div>
        {status?.replay && (
          <span className="lp-replay" role="status">
            Replaying {formatMediaTime(status.replay.startS)}–{formatMediaTime(status.replay.endS)}{' '}
            <button type="button" onClick={() => controller?.cancelReplay()}>
              Stop replay
            </button>
          </span>
        )}
      </div>
    </section>
  );
}
