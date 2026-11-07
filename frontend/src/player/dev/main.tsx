/**
 * Player dev harness (Person 4). Stands in for the review UI until @Betty505's composition exists:
 * shows the player, its live PlaybackStatus, a media-event log, and seek/replay buttons that use
 * the same PlayerHandle the review UI will use. Synthetic mode is labelled, as required.
 */
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createReviewClient, useReviewConnection, useReviewSnapshot } from '../../integration';
import { LecturePlayer, formatMediaTime, type PlaybackStatus, type PlayerHandle } from '..';

const NOOP = () => () => {};

function Harness() {
  const [client] = useState(() => createReviewClient());
  useReviewConnection(client);
  const snap = useReviewSnapshot(client);
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [start, setStart] = useState('10');
  const [end, setEnd] = useState('20');

  useEffect(() => {
    if (!player) return;
    return player.onMediaEvent((event, s) => {
      if (event === 'timeupdate') return; // too noisy; heartbeats are derived from it
      const line = `${new Date().toISOString().slice(11, 23)}  ${event.padEnd(14)} t=${s.mediaTimeS.toFixed(2)}s rate=${s.playbackRate} paused=${s.paused}`;
      setLog((l) => [line, ...l].slice(0, 40));
    });
  }, [player]);

  const status: PlaybackStatus | null = useSyncExternalStore(
    player?.subscribe ?? NOOP,
    () => player?.getState() ?? null,
  );

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, display: 'grid', gap: 16 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 20 }}>Player dev harness (Person 4)</h1>
        <p role="status" style={{ margin: '4px 0', fontWeight: 600, color: snap.kind === 'synthetic' ? '#9a3412' : '#166534' }}>
          {snap.kind === 'synthetic' ? 'SYNTHETIC DATA: no backend, no sensors' : 'Live adapter'} · connection:{' '}
          {snap.connection.state} · session: {snap.session?.sessionId ?? 'none'} · video: {snap.session?.videoId ?? 'none'}
        </p>
      </header>

      <LecturePlayer client={client} ref={setPlayer} />

      <section aria-label="Review UI stand-in" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Review UI stand-in</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" disabled={!player} onClick={() => player?.seek(30)}>
            seek(30)
          </button>
          <label>
            start <input value={start} onChange={(e) => setStart(e.currentTarget.value)} size={5} />
          </label>
          <label>
            end <input value={end} onChange={(e) => setEnd(e.currentTarget.value)} size={5} />
          </label>
          <button
            type="button"
            disabled={!player}
            onClick={() => player?.replayRange(Number(start), Number(end)).catch((e: unknown) => alert(String(e)))}
          >
            replayRange
          </button>
        </div>
        <ul style={{ margin: 0 }}>
          {snap.bookmarks.length === 0 && <li>No suggested review points yet.</li>}
          {snap.bookmarks.map((b) => (
            <li key={b.bookmarkId}>
              {b.source} suggested at {formatMediaTime(b.suggestedMediaS)}{' '}
              <button type="button" onClick={() => void player?.replayRange(b.suggestedMediaS, b.suggestedMediaS + 15)}>
                Replay 15 s
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Diagnostics" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>PlaybackStatus</h2>
          <pre style={{ fontSize: 12 }}>{JSON.stringify(status, null, 2)}</pre>
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Media events (newest first, timeupdate hidden)</h2>
          <pre style={{ fontSize: 12, maxHeight: 320, overflow: 'auto' }}>{log.join('\n')}</pre>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
