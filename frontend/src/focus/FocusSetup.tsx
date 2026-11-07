import type { LoadedLecture, PlayerHandle } from '../player';
import { GazeCalibration } from '../../../evaluation/player/GazeCalibration';
import type { useFocusReview } from './useFocusReview';
import './focus.css';

export function FocusSetup({ player, lecture, focus }: {
  player: PlayerHandle | null;
  lecture: LoadedLecture | null;
  focus: ReturnType<typeof useFocusReview>;
}) {
  return <div className="focus-tools">
    <GazeCalibration key={lecture?.videoId ?? 'none'} player={player} buffer={focus.gaze} onStarted={focus.start} />
    <p>Experimental EEG + gaze · EEG uses scripted or offline scores; webcam gaze stays local.</p>
    {focus.enabled && <>
      <p role="status">{focus.error || focus.snapshot?.fusion?.reason || 'Connecting EEG + gaze…'}</p>
      {focus.snapshot?.fusion && <p>Combined loss: {focus.snapshot.fusion.combinedLoss?.toFixed(2) ?? 'unknown'} · threshold {focus.snapshot.fusion.threshold.toFixed(2)}. Bookmarks have a 30 s cooldown.</p>}
      {focus.error && <button className="button button--outline button--small" onClick={focus.reconnect}>Reconnect focus tracking</button>}
    </>}
  </div>;
}
