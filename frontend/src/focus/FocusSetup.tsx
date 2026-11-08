import type { LoadedLecture, PlayerHandle } from '../player';
import { GazeCalibration } from '../../../evaluation/player/GazeCalibration';
import type { useFocusReview } from './useFocusReview';
import './focus.css';

export function FocusSetup({ player, lecture, focus, participant, onCalibrationBusyChange }: {
  player: PlayerHandle | null;
  lecture: LoadedLecture | null;
  focus: ReturnType<typeof useFocusReview>;
  participant?: string;
  onCalibrationBusyChange?: (busy: boolean) => void;
}) {
  return <div className="focus-tools">
    <GazeCalibration key={`${lecture?.videoId ?? 'none'}:${participant ?? 'local'}`} player={player} buffer={focus.gaze} onStarted={focus.start} client={focus.live ? focus.client : undefined} participant={participant} onBusyChange={onCalibrationBusyChange}
      onSample={(sample) => focus.gazeLive.push(sample, sample ? { videoId: lecture?.videoId ?? null, mediaTimeS: player?.getState().mediaTimeS ?? 0, paused: player?.getState().paused ?? true } : undefined)} />
    {focus.enabled && focus.error && <>
      <p role="status">{focus.error}</p>
      <button className="button button--outline button--small" onClick={focus.reconnect}>Reconnect focus tracking</button>
    </>}
    <details className="setup-help"><summary>About this tracking</summary>
      <p>{focus.live ? 'Live EEG + webcam gaze · experimental. A connected headset and calibrated camera are required; missing signals stay unavailable.' : 'Experimental EEG + gaze · EEG uses scripted or offline scores; webcam gaze stays local.'}</p>
      {focus.enabled && <p role="status">{focus.live ? 'Gaze is sent to your live session. It only supports review suggestions once the camera is calibrated.' : focus.snapshot?.fusion?.reason || 'Connecting EEG + gaze…'}</p>}
      {focus.snapshot?.fusion && <p>Combined loss: {focus.snapshot.fusion.combinedLoss?.toFixed(2) ?? 'unknown'} · threshold {focus.snapshot.fusion.threshold.toFixed(2)}. Bookmarks have a 30 s cooldown.</p>}
    </details>
  </div>;
}
