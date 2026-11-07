/**
 * LecturePlayer: open a local lecture video, play it, forward playback telemetry,
 * and expose a PlayerHandle (state, seek, replayRange) to the rest of the app.
 * Owner: Person 4 (@aryanmorarji). See src/player/README.md.
 */
import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react';
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

export interface LecturePlayerProps {
  client: ReviewClient;
  /** Session settings passed to client.startSession. Composition (Betty) decides these. */
  session?: Pick<StartSessionOptions, 'runKind' | 'sensors'>;
  ref?: Ref<PlayerHandle | null>;
  /** Called when a lecture is loaded or cleared. */
  onLectureChange?: (lecture: LoadedLecture | null) => void;
}

const DEFAULT_SESSION: Pick<StartSessionOptions, 'runKind' | 'sensors'> = {
  runKind: 'live',
  sensors: { eeg: true, gaze: true },
};
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const NOOP_SUBSCRIBE = () => () => {};

export function LecturePlayer({ client, session = DEFAULT_SESSION, ref, onLectureChange }: LecturePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
    const detachTelemetry = attachMediaElement(client, el);
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

  const ready = load.kind === 'ready' && status !== null;
  const playing = ready && !status.paused && !status.ended;

  return (
    <section className="lp" aria-label="Lecture player">
      <div className="lp-toolbar">
        <label className="lp-open">
          <span>Open lecture</span>
          <input
            type="file"
            accept="video/*,.mp4,.m4v,.webm,.mov,.ogv,.mkv"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = ''; // allow re-selecting the same file
              if (file) void openFile(file);
            }}
          />
        </label>
        {lecture && (
          <span className="lp-filename" title={lecture.fileName}>
            {lecture.fileName}
          </span>
        )}
      </div>

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
          <p className="lp-message">No lecture open. Choose a video file from this device; it is not uploaded.</p>
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
      </div>

      <div className="lp-controls" aria-disabled={!ready}>
        <button type="button" disabled={!ready} onClick={() => void controller?.togglePlay()}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          className="lp-seek"
          type="range"
          aria-label="Seek"
          min={0}
          max={status?.durationS ?? 0}
          step={0.1}
          value={ready ? status.mediaTimeS : 0}
          disabled={!ready || status.durationS === null}
          onChange={(e) => controller?.seek(Number(e.currentTarget.value))}
        />
        <span className="lp-time" aria-live="off">
          {formatMediaTime(ready ? status.mediaTimeS : null)} / {formatMediaTime(ready ? status.durationS : null)}
        </span>
        <button type="button" disabled={!ready} onClick={() => controller?.setMuted(!status?.muted)}>
          {status?.muted ? 'Unmute' : 'Mute'}
        </button>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={status ? (status.muted ? 0 : status.volume) : 1}
          disabled={!ready}
          onChange={(e) => controller?.setVolume(Number(e.currentTarget.value))}
        />
        <label>
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
