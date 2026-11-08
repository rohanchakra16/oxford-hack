import { useEffect, useState } from 'react';
import type { PlayerHandle } from '../player';
import { type GazeLiveStore, type GazeState, useGazeNow } from './gazeLive';

const LABEL: Record<GazeState | 'none', string> = { on: 'Looking at the video', off: 'Looking away', uncertain: 'Uncertain', lost: 'Not measurable', none: 'No frames' };
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Webcam gaze by lecture time, separate from the EEG attention graph. It never shows a score: every second is
 * one of looking at the video, looking away, uncertain, or not measurable (face/eyes lost, camera off).
 */
export function GazeSection({ store, player, durationS, crosshair, border, onCrosshair, onBorder }: {
  store: GazeLiveStore; player: PlayerHandle | null; durationS: number | null;
  crosshair: boolean; border: boolean; onCrosshair(v: boolean): void; onBorder(v: boolean): void;
}) {
  const { sample, active } = useGazeNow(store);
  const [, setTick] = useState(0);
  const [time, setTime] = useState(0);
  useEffect(() => {
    const t = setInterval(() => { setTick((n) => n + 1); setTime(player?.getState().mediaTimeS ?? 0); }, 1000);
    return () => clearInterval(t);
  }, [player]);
  const dur = durationS && durationS > 0 ? durationS : 0;
  const runs = dur ? store.runs(dur) : [];
  const { observedS, fractions } = dur ? store.summary(dur) : { observedS: 0, fractions: null };
  const now: GazeState | 'none' = !active ? 'none' : sample?.state ?? 'lost';
  return <section className="gaze-section" aria-label="Webcam gaze" data-testid="gaze-section">
    <h3>Webcam gaze</h3>
    <p className="gaze-section__sub">Where the camera estimates you looked, by lecture time. Not an attention score, and independent of EEG.</p>
    <p className="gaze-now" data-testid="gaze-now" data-state={now} role="status">
      {active ? <>Now: <strong>{LABEL[now]}</strong>{now === 'lost' && sample?.reason ? ` (${sample.reason.replace(/_/g, ' ').toLowerCase()})` : ''}</> : 'Camera not tracking. Calibrate it in Session setup.'}
    </p>
    {dur > 0 && runs.length > 0 && observedS > 0 ? <>
      <svg className="gaze-strip" viewBox={`0 0 ${dur} 1`} preserveAspectRatio="none" role="img" data-testid="gaze-strip"
        aria-label={`Gaze by lecture time. ${fractions ? `Looking at the video ${pct(fractions.on)}, away ${pct(fractions.off)}, uncertain ${pct(fractions.uncertain)}, not measurable ${pct(fractions.lost)} of ${Math.round(observedS)} observed seconds.` : ''}`}>
        {runs.map((r) => r.state !== 'none' && <rect key={r.startS} className={`gaze-run gaze-run--${r.state}`} x={r.startS} width={r.endS - r.startS} y="0" height="1"><title>{`${LABEL[r.state]} · ${Math.floor(r.startS / 60)}:${String(Math.floor(r.startS % 60)).padStart(2, '0')}–${Math.floor(r.endS / 60)}:${String(Math.floor(r.endS % 60)).padStart(2, '0')}`}</title></rect>)}
        <rect className="gaze-playhead" x={Math.min(dur, time)} width={Math.max(dur / 400, 0.5)} y="0" height="1" />
      </svg>
      <ul className="gaze-legend">
        {(['on', 'off', 'uncertain', 'lost'] as const).map((k) => <li key={k}><i className={`gaze-run--${k}`} aria-hidden="true" />{LABEL[k]}{fractions ? ` ${pct(fractions[k])}` : ''}</li>)}
      </ul>
    </> : <p className="gaze-empty">No gaze recorded yet. Calibrate the camera in Session setup, then play the lecture; gaps mean the camera was off, not that you looked away.</p>}
    <div className="gaze-toggles" role="group" aria-label="Gaze overlays on the video">
      <label><input type="checkbox" checked={crosshair} onChange={(e) => onCrosshair(e.target.checked)} /> Show gaze crosshair</label>
      <label><input type="checkbox" checked={border} onChange={(e) => onBorder(e.target.checked)} /> Red border when looking away</label>
    </div>
  </section>;
}
