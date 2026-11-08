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
        if (!response.ok) {
          // 409 (model_output_unavailable) and 404/501/503: this session has no score source attached.
          // 401/403: the session did not accept this page's pairing. Anything else is a failed read.
          if (response.status === 401 || response.status === 403) throw new Error('The local session did not accept this page. Reopen the app from the launcher link.');
          throw new Error([404, 409, 501, 503].includes(response.status)
            ? 'No compatible attention-score source is connected, so the graph shows your markers and review moments only.'
            : 'Attention scores could not be read from the local session. Retrying.');
        }
        const next: PersonalAttention = await response.json();
        if (abort.signal.aborted) return;
        setState(next); setError('');
        store.setAvailability(next.score === null ? { state: 'unavailable', message: next.reason || next.calibrationMessage } : { state: 'available' });
        if (next.media) {
          lastMapped = next.media; gapAdded = false;
          store.record({ sessionId, videoId, segmentId: next.media.segmentId,
          evidence: next.media, mediaS: next.media.endMediaS, value: next.score,
          metric: 'attention_score', scale: 'score_0_100', valid: next.score !== null,
          origin: 'measured', provenance: 'Personal attention model · personal baseline · 2.5 s smoothing',
          threshold: next.threshold, thresholdVersion: 'personal-model-v1' });
        } else {
          // A gap has no inferred score. Position it just after the last mapped
          // sample so a disconnect/pause cannot draw a continuous attention line.
          addGap();
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          const message = e instanceof TypeError ? 'The local session could not be reached, so no attention scores are available.' : e instanceof Error ? e.message : 'Attention scores are unavailable';
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
    <label>Profile name <input aria-label="Profile name" key={attention.participant} defaultValue={attention.participant} disabled={s?.calibrating} maxLength={64} onBlur={(e) => attention.setParticipant(e.target.value)} /></label>
    <p role="status">{(attention.error.startsWith('No compatible') ? 'Attention calibration is unavailable: no compatible score source is connected.' : attention.error) || (s?.calibrating ? s.calibrationMessage : s?.profile ? 'Saved baseline ready for this model and device configuration.' : s?.calibrationMessage) || 'Attention calibration needs a connected EEG score source. No score is inferred from missing data.'}</p>
    {!enabled && <p>Open a lecture and connect the local session to calibrate.</p>}
    {s?.calibrating && <><progress value={s.progress} max={1} aria-label="Calibration progress" /><p>Watch attentively for 20 seconds. This keeps running if you close setup.</p></>}
    <div className="bookmark-actions">
      <button className="button button--outline button--small" disabled={!enabled || s?.calibrating} onClick={() => void attention.action('start')}>{s?.profile ? 'Recalibrate' : 'Calibrate attention'}</button>
      {s?.calibrating && <button className="button button--quiet button--small" onClick={() => void attention.action('cancel')}>Cancel</button>}
      {s?.profile && <button className="button button--quiet button--small" onClick={() => void attention.action('reset')}>Reset baseline</button>}
    </div>
    <details className="setup-help"><summary>Calibration details</summary>
      <p>Your profile is remembered on this computer. Compatible EEG baselines load automatically for future lectures.</p>
      {s?.profile && <p>Saved {new Date(s.profile.created * 1000).toLocaleDateString()} · Mean {s.profile.mean.toFixed(1)} · SD {s.profile.std.toFixed(1)} · low ≤ {s.profile.low.toFixed(1)} · recovery ≥ {s.profile.recovery.toFixed(1)}</p>}
      <p>Model score {s?.score === null || s?.score === undefined ? 'unavailable' : `${s.score.toFixed(0)} / 100 · ${s.level}`}. This is a normalized model output, not a probability of attention.</p>
    </details>
  </section>;
}
