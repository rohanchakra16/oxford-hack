import { useEffect, useState } from 'react';
import { DEFAULT_BACKEND_URL, type ReviewClient } from '../integration';
import { getLaunchToken } from '../integration/live/pairing';
import type { AttentionTimelineStore } from '../attention';

export interface PersonalAttention {
  state: string; reason: string; raw: number | null; score: number | null;
  level: string; participant: string; calibrating: boolean; progress: number;
  calibrationMessage: string; threshold: number;
  profile: { mean: number; std: number; p10: number; p90: number; low: number; recovery: number; created: number } | null;
  media: { segmentId: string; startMediaS: number; endMediaS: number } | null;
}

export function usePersonalAttention(client: ReviewClient, sessionId: string | undefined, videoId: string | undefined, store: AttentionTimelineStore) {
  const [state, setState] = useState<PersonalAttention | null>(null);
  const [error, setError] = useState('');
  const [participant, setParticipant] = useState(() => { try { return localStorage.getItem('remind.participant') || 'local'; } catch { return 'local'; } });
  const backend = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? DEFAULT_BACKEND_URL;
  useEffect(() => {
    setState(null); setError('');
    if (client.kind !== 'live' || !sessionId || !videoId) return;
    const abort = new AbortController();
    let lastMapped: PersonalAttention['media'] = null;
    let gapAdded = false;
    const addGap = () => {
      if (!lastMapped || gapAdded) return;
      store.record({ sessionId, videoId, segmentId: lastMapped.segmentId, evidence: null,
        mediaS: (lastMapped.startMediaS + lastMapped.endMediaS) / 2 + .001,
        metric: 'attention_score', scale: 'score_0_100', value: null, valid: false,
        origin: 'measured', provenance: 'Model unavailable after last mapped evidence' });
      gapAdded = true;
    };
    const headers = () => ({ 'content-type': 'application/json', 'x-launch-token': getLaunchToken() ?? '' });
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const response = await fetch(`${backend}/api/v0/attention/${sessionId}`, { headers: headers(), signal: abort.signal });
        if (!response.ok) throw new Error('Live model output unavailable. Check the model connection and pairing.');
        const next: PersonalAttention = await response.json();
        if (abort.signal.aborted) return;
        setState(next); setError('');
        store.setAvailability(next.score === null ? { state: 'unavailable', message: next.reason || next.calibrationMessage } : { state: 'available' });
        if (next.media) {
          lastMapped = next.media; gapAdded = false;
          store.record({ sessionId, videoId, segmentId: next.media.segmentId,
          evidence: next.media, mediaS: next.media.endMediaS, value: next.score,
          metric: 'attention_score', scale: 'score_0_100', valid: next.score !== null,
          origin: 'measured', provenance: 'Annie model output · personal baseline · 2.5 s smoothing',
          threshold: next.threshold, thresholdVersion: 'personal-model-v1' });
        } else {
          // A gap has no inferred score. Position it just after the last mapped
          // sample so a disconnect/pause cannot draw a continuous attention line.
          addGap();
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          const message = e instanceof Error ? e.message : 'Live model unavailable';
          addGap();
          setState(null); setError(message); store.setAvailability({ state: 'unavailable', message });
        }
      } finally { if (!abort.signal.aborted) timer = setTimeout(read, 500); }
    };
    void fetch(`${backend}/api/v0/attention/${sessionId}/calibration`, { method: 'POST', headers: headers(), signal: abort.signal,
      body: JSON.stringify({ action: 'load', participant }) }).then(read).catch(() => { if (!abort.signal.aborted) void read(); });
    return () => { abort.abort(); clearTimeout(timer); };
  }, [client, sessionId, videoId, store, backend, participant]);

  const action = async (action: 'start' | 'reset' | 'cancel') => {
    if (!sessionId) return;
    try {
      const response = await fetch(`${backend}/api/v0/attention/${sessionId}/calibration`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-launch-token': getLaunchToken() ?? '' },
        body: JSON.stringify({ action, participant }) });
      if (!response.ok) throw new Error('Calibration unavailable: connect the model and start a lecture.');
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Calibration unavailable'); }
  };
  return { state, error, participant, setParticipant: (name: string) => {
    const value = name.trim() || 'local'; setParticipant(value);
    try { localStorage.setItem('remind.participant', value); } catch { /* in-memory profile remains usable */ }
  }, action };
}

export function PersonalCalibration({ attention, enabled }: { attention: ReturnType<typeof usePersonalAttention>; enabled: boolean }) {
  const s = attention.state;
  return <section className="focus-tools personal-calibration" aria-label="Personal attention calibration">
    <h2>Personal calibration</h2>
    <label>Local participant <input aria-label="Local participant" key={attention.participant} defaultValue={attention.participant} maxLength={64} onBlur={(e) => attention.setParticipant(e.target.value)} /></label>
    <p role="status">{attention.error || (s?.calibrating ? s.calibrationMessage : s?.profile ? 'Saved baseline ready for this model and device configuration.' : s?.calibrationMessage) || 'Connect Annie’s model to calibrate. No attention score is inferred from missing data.'}</p>
    {s?.calibrating && <><progress value={s.progress} max={1} aria-label="Calibration progress" /><p>Watch the lecture attentively. Only usable model outputs count.</p></>}
    <div className="bookmark-actions">
      <button className="button button--outline button--small" disabled={!enabled || s?.calibrating} onClick={() => void attention.action('start')}>{s?.profile ? 'Recalibrate' : 'Calibrate attention'}</button>
      {s?.calibrating && <button className="button button--quiet button--small" onClick={() => void attention.action('cancel')}>Cancel</button>}
      {s?.profile && <button className="button button--quiet button--small" onClick={() => void attention.action('reset')}>Reset baseline</button>}
    </div>
    {s?.profile && <small>Mean {s.profile.mean.toFixed(1)} · SD {s.profile.std.toFixed(1)} · low ≤ {s.profile.low.toFixed(1)} · recovery ≥ {s.profile.recovery.toFixed(1)}</small>}
    <p>Model score {s?.score === null || s?.score === undefined ? 'unavailable' : `${s.score.toFixed(0)} / 100 · ${s.level}`}. This is a normalized model output, not a probability of attention.</p>
  </section>;
}
