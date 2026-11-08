import { useEffect, useRef, useState } from 'react';
import type { PlayerHandle } from '../../frontend/src/player';
import type { GazeCamera } from './gaze-runtime';
import { readGazeMemory, resetGazeMemory, saveGazeMemory } from './gaze-memory';
import { GazeWindowBuffer } from './gaze';
import type { ReviewClient } from '../../frontend/src/integration';
import type { GazeCalibration as Calibration } from '../../frontend/src/contracts/generated/types';

export function GazeCalibration({ player, buffer, onStarted, client, participant = 'local' }: { player: PlayerHandle | null; buffer: GazeWindowBuffer; onStarted?: () => void; client?: ReviewClient; participant?: string }) {
  const engine = useRef<GazeCamera | null>(null);
  const abort = useRef(new AbortController());
  const calibration = useRef<Omit<Calibration, 'provenance'> | null>(null);
  const invalidate = () => {
    if (calibration.current) client?.sendGazeCalibration({ ...calibration.current, status: 'expired', invalidatedReason: 'Camera stopped or unavailable', tBrowserMs: performance.now() });
    calibration.current = null;
  };
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => readGazeMemory(participant));
  const [status, setStatus] = useState(() => readGazeMemory(participant)
    ? 'Saved camera setup found. A brief dot check verifies it with your current camera and seating.'
    : 'Calibrate your camera once. Its settings will be saved for this local profile.');
  const [target, setTarget] = useState<{ x: number; y: number; step: number; total: number } | null>(null);

  useEffect(() => () => {
    abort.current.abort();
    engine.current?.stop();
    if (calibration.current) client?.sendGazeCalibration({ ...calibration.current, status: 'expired', invalidatedReason: 'Lecture or camera changed', tBrowserMs: performance.now() });
    buffer.clear();
  }, [buffer, client]);

  const calibrate = async (reuse = false) => {
    if (!player || busy) return;
    onStarted?.();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setStatus('Starting the camera…'); buffer.clear();
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
            setStatus(event.status === 'valid'
              ? 'Camera calibrated. Your EEG baseline is managed in Personal calibration above.'
              : event.status === 'in_progress' ? 'Follow each calibration dot with your eyes.' : 'Calibration unavailable. Recalibrate to continue.');
          },
          onUnavailable: (message) => {
            if (engine.current === gaze && !abort.current.signal.aborted) { buffer.clear(); invalidate(); setStatus(`Camera unavailable: ${message}`); }
          },
        });
        engine.current = gaze;
      }
      const camera = engine.current;
      await camera.start();
      if (controller.signal.aborted) { camera.stop(); return; }
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
          setStatus(reuse ? 'Saved camera setup verified. Tracking is ready.' : 'Camera calibrated and saved for future lectures.');
        } else setStatus('Camera ready for this session. Browser storage is unavailable; settings could not be saved.');
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        buffer.clear(); engine.current?.stop(); engine.current = null;
        invalidate();
        setStatus(`Calibration unavailable: ${(error as Error).message}. Check camera permission and the gaze assets setup.`);
      }
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setTarget(null); }
    }
  };

  const stop = () => {
    abort.current.abort(); engine.current?.stop(); engine.current = null;
    invalidate();
    buffer.clear(); setTarget(null); setBusy(false); setStatus('Camera stopped. Combined bookmarks are paused until recalibration.');
  };

  return <section className="panel" aria-label="EEG and gaze calibration">
    <h2>Camera &amp; gaze</h2>
    <p>Follow the dots while sitting comfortably. Saved settings need a short camera check on each run. Webcam processing stays in your browser.</p>
    <p role="status" data-testid="gaze-status">{status}</p>
    {saved && <button disabled={!player?.getLecture() || busy} onClick={() => void calibrate(true)}>Use saved camera setup</button>}
    <button disabled={!player?.getLecture() || busy} onClick={() => void calibrate()}>Calibrate EEG + gaze</button>
    <button disabled={!busy && !engine.current} onClick={stop}>Stop camera</button>
    {saved && <button disabled={busy} onClick={() => { stop(); resetGazeMemory(participant); setSaved(null); setStatus('Saved camera setup removed for this profile. Calibrate to start again.'); }}>Reset saved camera setup</button>}
    {target && <div className="calibration-overlay" role="dialog" aria-modal="true" aria-label="Gaze calibration" onKeyDown={(event) => { if (event.key === 'Escape') stop(); if (event.key === 'Tab') event.preventDefault(); }}>
      <div className="calibration-instructions"><p>Look at the dot · {target.step} / {target.total}</p><button autoFocus onClick={stop}>Cancel calibration</button></div>
      <span className="calibration-dot" style={{ left: target.x, top: target.y }} aria-hidden="true" />
    </div>}
  </section>;
}
