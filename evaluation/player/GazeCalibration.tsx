import { useEffect, useRef, useState } from 'react';
import type { PlayerHandle } from '../../frontend/src/player';
import type { GazeCamera, GazeSample } from './gaze-runtime';
import { readGazeMemory, resetGazeMemory, saveGazeMemory } from './gaze-memory';
import { GazeWindowBuffer } from './gaze';
import type { ReviewClient } from '../../frontend/src/integration';
import type { GazeCalibration as Calibration } from '../../frontend/src/contracts/generated/types';


type CameraFailure = 'permission' | 'missing' | 'busy' | 'unknown';

/** Classifies what the camera layer rejected with. Only a recognised cause gets cause-specific advice. */
export function explainCameraFailure(error: unknown): { kind: CameraFailure; message: string } {
  const e = error as { name?: string; code?: string; message?: string } | string | null | undefined;
  const text = typeof e === 'string' ? e : `${e?.name ?? ''} ${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/NotAllowed|PermissionDenied|PERMISSION_DENIED|denied|blocked|dismissed/i.test(text)) return { kind: 'permission', message: 'Camera access was blocked. Allow the camera for this site in your browser’s address bar, then calibrate again.' };
  if (/NotFound|DevicesNotFound|no camera|not found|device not found/i.test(text)) return { kind: 'missing', message: 'No camera was found. Connect one, then calibrate again.' };
  if (/NotReadable|TrackStart|CAMERA_IN_USE|in use|busy/i.test(text)) return { kind: 'busy', message: 'The camera is in use by another app. Close it, then calibrate again.' };
  // Our own saved-setup check explains itself; it is not a camera failure and must not be reworded as one.
  if (/saved calibration|saved camera|did not match your saved/i.test(text)) return { kind: 'unknown', message: `${(typeof e === 'string' ? e : e?.message)?.trim()} Press “Calibrate gaze” to set it up again.` };
  const detail = (typeof e === 'string' ? e : e?.message)?.trim();
  return { kind: 'unknown', message: `Camera setup failed${detail ? `: ${detail}` : ''}. The cause could not be identified. Check that the camera is connected, allowed for this site and not used by another app, then try again.` };
}

export function GazeCalibration({ player, buffer, onStarted, client, participant = 'local', onBusyChange, onSample }: { player: PlayerHandle | null; buffer: GazeWindowBuffer; onStarted?: () => void; client?: ReviewClient; participant?: string; onBusyChange?: (busy: boolean) => void; /** Local-only live gaze frames for on-screen feedback; null when tracking stops. */ onSample?: (sample: GazeSample | null) => void }) {
  const engine = useRef<GazeCamera | null>(null);
  // A ref, so a new callback identity each render never re-runs the camera cleanup effect.
  const sampleOut = useRef(onSample);
  sampleOut.current = onSample;
  const abort = useRef(new AbortController());
  const calibration = useRef<Omit<Calibration, 'provenance'> | null>(null);
  const invalidate = () => {
    if (calibration.current) client?.sendGazeCalibration({ ...calibration.current, status: 'expired', invalidatedReason: 'Camera stopped or unavailable', tBrowserMs: performance.now() });
    calibration.current = null;
  };
  const [busy, setBusy] = useState(false);
  /** Where the camera setup is: drives the step indicator only; behaviour is unchanged. */
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [phase, setPhase] = useState<'idle' | 'permission' | 'calibrating' | 'ready' | 'unavailable'>('idle');
  const [saved, setSaved] = useState(() => readGazeMemory(participant));
  const [status, setStatus] = useState(() => readGazeMemory(participant)
    ? 'Saved camera setup found. A brief dot check verifies it with your current camera and seating.'
    : 'Calibrate your camera once. Its settings will be saved for this local profile.');
  const [target, setTarget] = useState<{ x: number; y: number; step: number; total: number } | null>(null);

  useEffect(() => () => {
    abort.current.abort();
    engine.current?.stop();
    sampleOut.current?.(null);
    onBusyChange?.(false);
    if (calibration.current) client?.sendGazeCalibration({ ...calibration.current, status: 'expired', invalidatedReason: 'Lecture or camera changed', tBrowserMs: performance.now() });
    buffer.clear();
  }, [buffer, client, onBusyChange]);

  const calibrate = async (reuse = false) => {
    if (!player || busy) return;
    onStarted?.();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setPhase('permission'); setStatus('Starting the camera…'); buffer.clear();
    onBusyChange?.(true);
    try {
      const { createGazeCamera } = await import('./gaze-runtime');
      if (controller.signal.aborted) return;
      if (!engine.current) {
        const gaze = createGazeCamera({
          getVideoElement: () => player.getVideoElement(),
          onObservation: (frame) => {
            if (engine.current === gaze && !abort.current.signal.aborted) buffer.push(frame);
          },
          onObservationBatch: client ? (frames) => {
            if (engine.current === gaze && !abort.current.signal.aborted) client.sendGazeObservations(frames);
          } : undefined,
          onCalibration: (event) => {
            if (engine.current !== gaze || abort.current.signal.aborted) return;
            buffer.clear(event.status === 'valid' ? event.id : null);
            if (event.contract) { calibration.current = event.contract; client?.sendGazeCalibration(event.contract); }
            setPhase(event.status === 'valid' ? 'ready' : event.status === 'in_progress' ? 'calibrating' : 'unavailable');
            setStatus(event.status === 'valid'
              ? 'Camera calibrated. Your EEG baseline is managed in Personal calibration above.'
              : event.status === 'in_progress' ? 'Follow each calibration dot with your eyes.' : 'Calibration unavailable. Recalibrate to continue.');
          },
          onSample: (sample) => { if (engine.current === gaze && !abort.current.signal.aborted) sampleOut.current?.(sample); },
          onUnavailable: (message) => {
            if (engine.current === gaze && !abort.current.signal.aborted) { buffer.clear(); invalidate(); sampleOut.current?.(null); const f = explainCameraFailure(message); setPhase('unavailable'); setFailure(f.kind); setStatus(f.message); }
          },
        });
        engine.current = gaze;
      }
      const camera = engine.current;
      await camera.start();
      if (controller.signal.aborted) { camera.stop(); return; }
      setPhase('calibrating');
      const ui = {
        show: (point: { x: number; y: number }, step: number, total: number) => setTarget({ ...point, step: step + 1, total }),
        hide: () => setTarget(null),
      };
      if (reuse && saved) await camera.restoreCalibration(saved, ui, controller.signal);
      else await camera.calibrate(ui, controller.signal);
      if (controller.signal.aborted) return;
      const current = camera.getCalibration();
      if (current) {
        if (saveGazeMemory(participant, current)) {
          setSaved(current);
          setPhase('ready');
          setStatus(reuse ? 'Saved camera setup verified. Tracking is ready.' : 'Camera calibrated and saved for future lectures.');
        } else setStatus('Camera ready for this session. Browser storage is unavailable; settings could not be saved.');
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[gaze] setup failed', reuse ? '(saved setup check)' : '(calibration)', error);
        buffer.clear(); engine.current?.stop(); engine.current = null;
        invalidate();
        const f = explainCameraFailure(error);
        setPhase('unavailable'); setFailure(f.kind);
        setStatus(f.message);
      }
    } finally {
      if (!controller.signal.aborted) { setBusy(false); onBusyChange?.(false); setTarget(null); }
    }
  };

  const stop = () => {
    abort.current.abort(); engine.current?.stop(); engine.current = null;
    sampleOut.current?.(null);
    invalidate();
    onBusyChange?.(false);
    buffer.clear(); setTarget(null); setBusy(false); setPhase('idle'); setStatus('Camera stopped. Combined bookmarks are paused until recalibration.');
  };

  return <section className="panel gaze-setup" aria-label="Camera and gaze setup" data-phase={phase}>
    <h2>Camera &amp; gaze</h2>
    <ol className="gaze-steps" aria-label="Camera setup steps">
      <li data-step="permission">Allow camera</li>
      <li data-step="calibrating">Follow the dots</li>
      <li data-step="ready">{phase === 'unavailable' ? 'Unavailable' : 'Ready'}</li>
    </ol>
    <p role="status" data-testid="gaze-status" data-failure={phase === 'unavailable' ? failure ?? undefined : undefined}>{status}</p>
    {saved && <button disabled={!player?.getLecture() || busy} onClick={() => void calibrate(true)}>Use saved camera setup</button>}
    <button disabled={!player?.getLecture() || busy} onClick={() => void calibrate()}>Calibrate gaze</button>
    <button disabled={!busy && !engine.current} onClick={stop}>Stop camera</button>
    {saved && <button disabled={busy} onClick={() => { stop(); resetGazeMemory(participant); setSaved(null); setStatus('Saved camera setup removed for this profile. Calibrate to start again.'); }}>Reset saved camera setup</button>}
    {target && <div className="calibration-overlay" role="dialog" aria-modal="true" aria-label="Gaze calibration" onKeyDown={(event) => { if (event.key === 'Escape') stop(); if (event.key === 'Tab') event.preventDefault(); }}>
      <div className="calibration-instructions"><p>Look at the dot · {target.step} / {target.total}</p><button autoFocus onClick={stop}>Cancel calibration</button></div>
      <span className="calibration-dot" style={{ left: target.x, top: target.y }} aria-hidden="true" />
    </div>}
  </section>;
}
