import { type GazeLiveStore, useGazeNow } from './gazeLive';

/**
 * Debug feedback drawn inside the player: a crosshair at the estimated gaze position and a border around the
 * video. Both come from real calibrated webcam frames and say so when the estimate is not trustworthy:
 * - looking at the video: normal; confidently away: red border; uncertain or not measurable: neutral dashed border.
 * - the crosshair is solid when confident, dashed when uncertain, and hidden when the face or eyes are lost.
 * Nothing is shown unless the camera is calibrated and running.
 */
export function GazeOverlay({ store, crosshair, border }: { store: GazeLiveStore; crosshair: boolean; border: boolean }) {
  const { sample, active } = useGazeNow(store);
  if (!active) return null;
  const state = sample?.state ?? 'lost';
  return <>
    {border && state !== 'on' && <div className="gaze-border" data-state={state === 'off' ? 'off' : 'unsure'} data-testid="gaze-border" aria-hidden="true" />}
    {crosshair && sample?.viewport && (state === 'on' || state === 'off' || state === 'uncertain') && (
      <div className="gaze-crosshair" data-state={state} data-testid="gaze-crosshair" aria-hidden="true" style={{ left: sample.viewport.x, top: sample.viewport.y }}>
        <svg viewBox="-16 -16 32 32" width="32" height="32"><circle r="11" /><path d="M-16 0H-5M5 0H16M0 -16V-5M0 5V16" /></svg>
      </div>
    )}
  </>;
}
