/**
 * Attention UI dev page (#55). A reference composition of the components in ../, using the same
 * ReviewClient, LecturePlayer and PlayerHandle as the product. App.tsx composition belongs to
 * @rohanchakra16; this page exists so the features can be exercised and tested end to end.
 */
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createReviewClient, useReviewConnection, useReviewSnapshot } from '../../integration';
import { LecturePlayer, type PlayerHandle, type PlayerViewMode } from '../../player';
import {
  AttentionDemoPanel,
  AttentionGraph,
  AttentionInfoIndicator,
  AttentionSummary,
  AttentionTimelineStore,
  markerFromBookmark,
  useAttentionLecture,
  useTimeline,
  type AttentionMarker,
} from '..';
import './dev.css';

const NOOP = () => () => {};

function DevPage() {
  const [client] = useState(() => createReviewClient());
  useReviewConnection(client);
  const review = useReviewSnapshot(client);
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const [store] = useState(() => new AttentionTimelineStore());
  const [mode, setMode] = useState<PlayerViewMode>('normal');
  const [showSummary, setShowSummary] = useState(false);
  const timeline = useTimeline(store);
  const currentTime = useSyncExternalStore(player?.subscribe ?? NOOP, () => player?.getState().mediaTimeS ?? 0);
  const ended = useSyncExternalStore(player?.subscribe ?? NOOP, () => player?.getState().ended ?? false);
  const params = useMemo(() => new URLSearchParams(location.search), []);

  useAttentionLecture(store, player);
  useEffect(() => () => client.dispose(), [client]);

  // Dev-only console access.
  useEffect(() => {
    Object.assign(window as object, { __player: player, __attention: store });
  }, [player, store]);

  // Real bookmarks (authoritative list from the ReviewClient) -> markers. Simulated sessions are labelled by runKind.
  useEffect(() => {
    if (!timeline.videoId) return;
    const markers = review.bookmarks.filter((b) => b.videoId === timeline.videoId).map(markerFromBookmark);
    store.syncMarkers(markers, (m) => !m.id.startsWith('demo-'));
  }, [review.bookmarks, timeline.videoId, store]);

  // Live mode has no score stream until the EEG score contract is agreed.
  useEffect(() => {
    store.setAvailability(client.kind === 'live' ? { state: 'unavailable', message: 'Live score unavailable' } : { state: 'available' });
  }, [client, store]);

  // Show the summary when the lecture ends; reopening a completed lecture offers it again.
  useEffect(() => {
    if (ended) setShowSummary(true);
  }, [ended]);
  useEffect(() => {
    setShowSummary(false);
  }, [timeline.videoId]);

  const seek = (t: number, marker?: AttentionMarker) => {
    if (!player) return;
    if (marker && marker.endS !== null && marker.endS > t + 0.5) {
      void player.replayRange(t, marker.endS).catch(() => {
        player.seek(t);
        void player.play().catch(() => undefined);
      });
    } else {
      player.seek(t);
    }
  };

  const playerEl = (
    <LecturePlayer
      client={client}
      ref={setPlayer}
      viewMode={mode}
      onViewModeChange={setMode}
      session={{ runKind: client.kind === 'synthetic' ? 'simulated' : 'live', sensors: { eeg: true, gaze: true } }}
      overlay={<AttentionInfoIndicator store={store} onSeek={(t, m) => seek(t, m)} />}
    />
  );
  const graph = <AttentionGraph store={store} playback={player} variant="compact" onSeek={(t, target) => seek(t, target.kind === 'marker' ? target.marker : undefined)} />;

  return (
    <main className="dev-shell">
      <header className="dev-head">
        <div>
          <h1>Attention UI dev page</h1>
          <p role="status">
            {review.kind === 'synthetic' ? 'Synthetic adapter: example bookmarks are simulated.' : 'Live adapter.'} Connection {review.connection.state}.
            {params.get('adapter') !== 'synthetic' && ' Add ?adapter=synthetic to run without a backend.'}
          </p>
        </div>
        <div className="dev-head__actions">
          <button type="button" disabled={!player} onClick={() => player && client.markBookmark(currentTime)}>Mark moment</button>
          <button type="button" disabled={!timeline.videoId} onClick={() => setShowSummary((s) => !s)}>
            {showSummary ? 'Hide summary' : timeline.completed ? 'Attention summary (saved)' : 'Attention summary'}
          </button>
          <button type="button" disabled={!timeline.videoId} onClick={() => store.clear()}>Clear saved history</button>
        </div>
      </header>

      {/* One mounted player; the layout moves it (remounting would end the session). */}
      <div className={`dev-grid dev-grid--${mode}`}>
        <div className="dev-player">{playerEl}</div>
        <section className="dev-main">
          {mode === 'minimised' && !showSummary && (
            <p className="dev-placeholder">Lecture notes / review area. The player is minimised into the sidebar and keeps playing; the attention graph sits below it.</p>
          )}
          {showSummary && (
            <AttentionSummary store={store} playback={player} onSeek={(t, target) => { seek(t, target.kind === 'marker' ? target.marker : undefined); }} onClose={() => setShowSummary(false)} />
          )}
        </section>
        <aside className="dev-side" aria-label="Sidebar">
          {graph}
          <AttentionDemoPanel store={store} playback={player} />
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DevPage />
  </StrictMode>,
);
