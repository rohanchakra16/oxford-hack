import { useEffect, useRef, useState } from 'react';
import type { PlayerHandle } from '../../frontend/src/player';
import type { GazeCamera } from './gaze-runtime';
import { GazeWindowBuffer } from './gaze';

export function GazeCalibration({ player, buffer, onStarted }: { player: PlayerHandle | null; buffer: GazeWindowBuffer; onStarted?: () => void }) {
  const engine = useRef<GazeCamera | null>(null);
  const abort = useRef(new AbortController());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Calibrate once to enable EEG + gaze bookmarks.');
  const [target, setTarget] = useState<{ x: number; y: number; step: number; total: number } | null>(null);

  useEffect(() => () => {
    abort.current.abort();
    engine.current?.stop();
    buffer.clear();
  }, [buffer]);

  const calibrate = async () => {
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
          onCalibration: (event) => {
            if (engine.current !== gaze || abort.current.signal.aborted) return;
            buffer.clear(event.status === 'valid' ? event.id : null);
            setStatus(event.status === 'valid'
              ? 'Camera calibrated. Play and watch normally for 8 seconds to set the EEG + gaze baseline.'
              : event.status === 'in_progress' ? 'Follow each calibration dot with your eyes.' : 'Calibration unavailable. Recalibrate to continue.');
          },
          onUnavailable: (message) => {
            if (engine.current === gaze && !abort.current.signal.aborted) { buffer.clear(); setStatus(`Camera unavailable: ${message}`); }
          },
        });
        engine.current = gaze;
      }
      const camera = engine.current;
      await camera.start();
      if (controller.signal.aborted) { camera.stop(); return; }
      await camera.calibrate({
        show: (point, step, total) => setTarget({ ...point, step: step + 1, total }),
        hide: () => setTarget(null),
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        buffer.clear(); engine.current?.stop(); engine.current = null;
        setStatus(`Calibration unavailable: ${(error as Error).message}. Check camera permission and the gaze assets setup.`);
      }
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setTarget(null); }
    }
  };

  const stop = () => {
    abort.current.abort(); engine.current?.stop(); engine.current = null;
    buffer.clear(); setTarget(null); setBusy(false); setStatus('Camera stopped. Combined bookmarks are paused until recalibration.');
  };

  return <section className="panel" aria-label="EEG and gaze calibration">
    <h2>EEG + eye tracking</h2>
    <p>Follow the camera dots, then watch normally for 8 seconds. Webcam processing stays in your browser.</p>
    <p role="status" data-testid="gaze-status">{status}</p>
    <button disabled={!player?.getLecture() || busy} onClick={() => void calibrate()}>Calibrate EEG + gaze</button>
    <button disabled={!busy && !engine.current} onClick={stop}>Stop camera</button>
    {target && <div className="calibration-overlay" role="dialog" aria-modal="true" aria-label="Gaze calibration" onKeyDown={(event) => { if (event.key === 'Escape') stop(); if (event.key === 'Tab') event.preventDefault(); }}>
      <div className="calibration-instructions"><p>Look at the dot · {target.step} / {target.total}</p><button autoFocus onClick={stop}>Cancel calibration</button></div>
      <span className="calibration-dot" style={{ left: target.x, top: target.y }} aria-hidden="true" />
    </div>}
  </section>;
}
