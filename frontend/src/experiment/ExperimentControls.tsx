import { useCallback, useState } from 'react';
import type { useExperiment } from './useExperiment';
import { EXPERIMENT_LOW_THRESHOLD } from './runtime';
import type { PlayerHandle } from '../player';
import { GazeCalibration } from '../../../evaluation/player/GazeCalibration';
import './experiment.css';

export function ExperimentControls({ experiment, player = null, participant = 'local', onCalibrationBusyChange }: {
  experiment: ReturnType<typeof useExperiment>;
  player?: PlayerHandle | null;
  participant?: string;
  onCalibrationBusyChange?: (busy: boolean) => void;
}) {
  const [sampleRate, setSampleRate] = useState('250');
  const [calibrating, setCalibrating] = useState(false);
  const onBusyChange = useCallback((busy: boolean) => {
    setCalibrating(busy); onCalibrationBusyChange?.(busy);
  }, [onCalibrationBusyChange]);
  const { enabled, source, reading, error, loading } = experiment;
  return <details className="setup-help experiment-controls">
    <summary>Experimental mode · testing only</summary>
    <label className="experiment-toggle"><input type="checkbox" checked={enabled} disabled={calibrating} onChange={(e) => experiment.setEnabled(e.target.checked)} /> Enable experimental mode</label>
    <p>Replay an EEG CSV locally with randomized gaze or your calibrated webcam. No headset is needed. Test results stay separate from live history.</p>
    {enabled && <>
      <label className="experiment-field">Experiment gaze source
        <select value={experiment.gazeMode} disabled={calibrating} onChange={(e) => experiment.setGazeMode(e.target.value as 'randomized' | 'webcam')}>
          <option value="randomized">Randomized gaze · no camera</option>
          <option value="webcam">Calibrated webcam gaze</option>
        </select>
      </label>
      {experiment.gazeMode === 'webcam' && <>
        <p>Open a lecture video, then calibrate your eyes by following the dot. Play the lecture to test the EEG CSV and webcam together. Camera samples stay in this browser; experiment camera settings use a separate test profile.</p>
        {!player?.getLecture() && <p role="status">Open a lecture video to enable gaze calibration.</p>}
        <GazeCalibration key={`${experiment.gazeSessionKey}:${participant}`} player={player}
          buffer={experiment.gazeBuffer} participant={`experiment:${participant}`} onBusyChange={onBusyChange}
          onStarted={() => experiment.onGazeSample(null)} onSample={experiment.onGazeSample} />
      </>}
      <label className="experiment-field">Raw EEG sample rate (Hz)
        <input type="number" min={64} max={1000} value={sampleRate} onChange={(e) => setSampleRate(e.target.value)} />
      </label>
      <label className="experiment-field">Import EEG CSV
        <input type="file" accept=".csv,text/csv" disabled={loading} onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void experiment.importCsv(file, Number(sampleRate));
          e.target.value = '';
        }} />
      </label>
      <p>Use <code>time_s,attention_score</code> (0–100), or <code>timestamp,sample_index,Fz,Cz,Pz</code> with raw EEG channels. Timestamps are seconds; <code>time_ms</code> is also supported. Without timestamps, score rows play at one per second and raw EEG uses the sample rate above.</p>
      <p>CSV time zero matches lecture time zero. Play, pause or seek the lecture to explore the recording; it stops at the end of the CSV.</p>
      {loading && <p role="status">Processing EEG CSV…</p>}
      {error && <p role="alert">{error}</p>}
      {source && <p role="status">{source.name} · {source.replay.durationS.toFixed(1)} seconds · {source.replay.method === 'scores' ? 'Imported attention scores' : 'Spectral test proxy: beta / (theta + beta), not a trained attention model'}.</p>}
      {reading && <>
        {reading.gaze.source === 'randomized' && <div className="experiment-gaze" role="img" aria-label={`Simulated gaze: ${reading.gaze.away ? 'looking away' : 'on video'}`}>
          <span className="experiment-gaze__video">Video area</span>
          <span className="experiment-gaze__dot" style={{ left: `${reading.gaze.x! * 100}%`, top: `${reading.gaze.y! * 100}%` }} />
        </div>}
        <p role="status">EEG: {reading.eeg === null ? 'unavailable' : reading.eeg.toFixed(0)} · Combined test score: {reading.combined === null ? 'unavailable' : `${reading.combined.toFixed(0)} / 100`} · {reading.gaze.source === 'webcam' ? 'Webcam gaze' : 'Mock gaze'}: {{ on: 'on video', off: 'looking away', uncertain: 'uncertain', lost: 'not measurable' }[reading.gaze.state]}.</p>
        {reading.ended && <p>EEG CSV finished. Rewind the lecture to replay it.</p>}
      </>}
      <p>Test combination: 80% EEG score + 20% {experiment.gazeMode === 'webcam' ? 'calibrated webcam gaze. Uncertain, missing or stale gaze pauses combined scoring' : 'mock gaze'}. Eight seconds at or below {EXPERIMENT_LOW_THRESHOLD} adds a simulated review dot, with a 30-second cooldown. Closing setup keeps the experiment running; switch this mode off to stop the test camera and return to live signals. Changing gaze source clears the test graph.</p>
    </>}
  </details>;
}
