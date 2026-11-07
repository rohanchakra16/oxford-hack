/**
 * Developer diagnostics (Person 5). An ENGINEERING HARNESS, not a product screen:
 * connection/session/segment state, clock uncertainty, sensor status, validation errors,
 * rejected candidates and mapped bookmarks, plus controls to drive synthetic playback.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createReviewClient,
  LiveReviewClient,
  realTimers,
  selectedAdapter,
  useReviewSnapshot,
  type ReviewClient,
  type RunKind,
} from '../integration';
import { VirtualMedia } from './virtualMedia';

const fmt = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? '—' : n.toFixed(digits));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ border: '1px solid #8884', borderRadius: 6, padding: 12, marginBottom: 12 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>{title}</h2>
      {children}
    </section>
  );
}

export default function DiagnosticsPage() {
  const [client] = useState<ReviewClient>(() => createReviewClient());
  const snap = useReviewSnapshot(client);
  const [videoId, setVideoId] = useState('diagnostics-video');
  const [runKind, setRunKind] = useState<Extract<RunKind, 'live' | 'simulated'>>('simulated');
  const [eeg, setEeg] = useState(true);
  const [gaze, setGaze] = useState(false);
  const [seekTo, setSeekTo] = useState('30');
  const [raw, setRaw] = useState('{"not": "a valid message"');
  const [tick, setTick] = useState(0);
  const media = useMemo(() => new VirtualMedia(client, realTimers, 3600, () => setTick((t) => t + 1)), [client]);
  useSyncExternalStore(
    (cb) => {
      const id = window.setInterval(cb, 250);
      return () => window.clearInterval(id);
    },
    () => Math.floor(performance.now() / 250),
  );
  void tick;

  useEffect(() => {
    client.connect();
    return () => {
      media.dispose();
      client.dispose();
    };
  }, [client, media]);

  const live = client instanceof LiveReviewClient ? client : null;
  const c = snap.connection;
  const session = snap.session;
  const clock = snap.clock;
  const elig = snap.eligibility;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20 }}>Developer diagnostics</h1>
      <p role="note">
        Engineering harness (Person 5), not the product UI. Adapter: <strong data-testid="adapter-kind">{snap.kind}</strong>
        {selectedAdapter() === 'synthetic' && ' — SYNTHETIC: no backend, fake data.'} Playback below is a{' '}
        <strong>synthetic virtual media clock</strong>.
      </p>

      <Section title="Connection">
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
          <dt>State</dt>
          <dd data-testid="connection-state" style={{ margin: 0 }}>{c.state}</dd>
          <dt>Detail</dt>
          <dd data-testid="connection-detail" style={{ margin: 0 }}>{c.detail}</dd>
          <dt>Backend instance</dt>
          <dd data-testid="backend-instance" style={{ margin: 0 }}>{c.backendInstanceId ?? '—'}</dd>
          <dt>Backend restarted</dt>
          <dd style={{ margin: 0 }}>{String(c.backendRestarted)}</dd>
          <dt>Clock</dt>
          <dd data-testid="clock-state" style={{ margin: 0 }}>
            {clock?.state ?? '—'} · offset {fmt(clock?.offsetBrowserMinusBackendMs, 1)} ms · ±{fmt(clock?.uncertaintyMs, 1)} ms ·{' '}
            {clock?.sampleCount ?? 0} samples
          </dd>
        </dl>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={() => client.connect()}>Connect</button>
          <button type="button" onClick={() => client.disconnect()}>Disconnect</button>
          {live && <button type="button" onClick={() => live.simulateTransportDrop()}>Drop connection</button>}
        </div>
      </Section>

      <Section title="Session">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>
            Video id <input value={videoId} onChange={(e) => setVideoId(e.target.value)} />
          </label>
          <label>
            Run kind{' '}
            <select value={runKind} onChange={(e) => setRunKind(e.target.value as 'live' | 'simulated')}>
              <option value="simulated">simulated (synthetic producers)</option>
              <option value="live">live (real sensors only)</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={eeg} onChange={(e) => setEeg(e.target.checked)} /> EEG
          </label>
          <label>
            <input type="checkbox" checked={gaze} onChange={(e) => setGaze(e.target.checked)} /> Gaze
          </label>
          <button
            type="button"
            onClick={() => {
              client.startSession({ videoId, runKind, sensors: { eeg, gaze }, mediaDurationS: media.duration });
              media.load();
            }}
          >
            Start session
          </button>
          <button type="button" onClick={() => client.endSession('user_ended')}>End session</button>
        </div>
        <p>
          Session <strong data-testid="session-id">{session?.sessionId ?? '—'}</strong> · video{' '}
          <span data-testid="session-video">{session?.videoId ?? '—'}</span> · run kind{' '}
          <span data-testid="session-run-kind">{session?.runKind ?? '—'}</span> · detector{' '}
          {session?.config.detector?.detectorId ?? 'none'}
        </p>
      </Section>

      <Section title="Synthetic playback">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" onClick={() => media.play()}>Play</button>
          <button type="button" onClick={() => media.pause()}>Pause</button>
          <label>
            Seek to (s) <input value={seekTo} onChange={(e) => setSeekTo(e.target.value)} size={6} />
          </label>
          <button type="button" onClick={() => media.seek(Number(seekTo) || 0)}>Seek</button>
          <button type="button" onClick={() => media.setRate(media.snapshot().playbackRate === 1 ? 1.5 : 1)}>
            Toggle 1×/1.5×
          </button>
          <button type="button" onClick={() => media.buffer(1500)}>Buffer 1.5 s</button>
        </div>
        <p
          data-testid="media-state"
          data-media-time={media.position()}
          data-segment-start-browser-ms={media.segmentStartBrowserMs ?? ''}
          data-segment-start-media-s={media.segmentStartMediaS ?? ''}
          data-rate={media.snapshot().playbackRate}
        >
          Media {fmt(media.position())} s · rate {media.snapshot().playbackRate}× · {media.snapshot().paused ? 'paused' : 'playing'}
        </p>
        <p>
          Eligibility: <span data-testid="eligibility">{elig ? `${elig.eligible ? 'eligible' : 'not eligible'} (${elig.reason})` : '—'}</span>
          {' '}· segment <span data-testid="segment-id">{elig?.segmentId ?? '—'}</span> · epoch {elig?.epoch ?? '—'}
        </p>
      </Section>

      <Section title="Sensors">
        {snap.sensors ? (
          <ul>
            <li data-testid="sensor-eeg">EEG: {snap.sensors.eeg.state}{snap.sensors.eeg.reasons.length ? ` — ${snap.sensors.eeg.reasons.join('; ')}` : ''}</li>
            <li data-testid="sensor-gaze">Gaze: {snap.sensors.gaze.state}{snap.sensors.gaze.reasons.length ? ` — ${snap.sensors.gaze.reasons.join('; ')}` : ''}</li>
            <li data-testid="sensor-mode">Mode: {snap.sensors.mode} · automatic suggestions {snap.sensors.automaticSuggestions ? 'on' : 'off'} ({snap.sensors.automaticReason})</li>
          </ul>
        ) : (
          <p>No sensor status yet.</p>
        )}
      </Section>

      <Section title="Bookmarks">
        <p data-testid="bookmark-count">{snap.bookmarks.length} bookmark(s)</p>
        <table aria-label="Mapped bookmarks" style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr><th>id</th><th>source</th><th>run</th><th>suggested s</th><th>evidence media s</th><th>segment</th><th>± ms</th></tr>
          </thead>
          <tbody>
            {snap.bookmarks.map((b) => (
              <tr
                key={b.bookmarkId}
                data-testid="bookmark-row"
                data-bookmark-id={b.bookmarkId}
                data-suggested-media-s={b.suggestedMediaS}
                data-evidence-start-media-s={b.evidenceMedia?.startMediaS ?? ''}
                data-evidence-end-media-s={b.evidenceMedia?.endMediaS ?? ''}
                data-uncertainty-ms={b.mappingUncertaintyMs ?? ''}
              >
                <td>{b.bookmarkId}</td>
                <td>{b.source}</td>
                <td>{b.runKind}</td>
                <td>{fmt(b.suggestedMediaS)}</td>
                <td>{b.evidenceMedia ? `${fmt(b.evidenceMedia.startMediaS)}–${fmt(b.evidenceMedia.endMediaS)}` : '—'}</td>
                <td>{b.segmentId ?? '—'}</td>
                <td>{fmt(b.mappingUncertaintyMs, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={() => client.markBookmark(media.position())} style={{ marginTop: 8 }}>
          Manual bookmark at current time
        </button>
      </Section>

      <Section title="Rejected candidates">
        <ul aria-label="Rejected candidates">
          {snap.rejections.map((r, i) => (
            <li key={i} data-testid="rejection" data-reason={r.reason}>
              {r.eventId ?? '—'}: {r.reason} — {r.detail}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Errors">
        <ul aria-label="Errors">
          {snap.errors.map((e, i) => (
            <li key={i} data-testid="error" data-code={e.code}>
              [{e.source}] {e.code}{e.fatal ? ' (fatal)' : ''}: {e.message}
            </li>
          ))}
        </ul>
        {live && (
          <div>
            <label>
              Raw message to send (diagnostics only)
              <br />
              <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={3} cols={80} />
            </label>
            <br />
            <button type="button" onClick={() => live.sendRawForDiagnostics(raw)}>Send raw message</button>
          </div>
        )}
      </Section>
    </main>
  );
}
