# Attention UI (#55)

Owner: Person 4 (@aryanmorarji). Placement and ownership were agreed on the board (#1) with @rohanchakra16:
this folder holds the bounded graph store and the graph, summary and ⓘ indicator components. Rohan
owns `frontend/src/product/` and mounts them there. This module adds **no** second history store,
connection or player. It never opens a socket and it never owns a `<video>`.

## What it does

| Piece | What the user sees |
|---|---|
| `AttentionGraph variant="compact"` | Live sidebar graph: attention line, shaded low-attention regions, a dashed threshold, review-point (●) and bookmark (◆) markers, and a playhead. The line refreshes every 2 minutes (or on "Next update" click); markers appear immediately. Markers and low regions are clickable (seek) and have tooltips. Keyboard: Tab to a marker, then Enter/Space. |
| `AttentionGraph variant="full"` | The same graph, larger, updated live. Used inside the summary. |
| `AttentionSummary` | After completion: average, lowest point, low-attention time, review-point and bookmark counts, the full graph, the three lowest periods and every marker as chips. Can be reopened later from local storage. |
| `AttentionInfoIndicator` | YouTube-style ⓘ in the top-right of the video, raised by a new review point or bookmark. It fades out after 6 s. Its popover shows type, time, score, reason and a "Go to" button, and closes on Esc or an outside click. It never pauses playback. Closely spaced events are coalesced (newest first, max 5, de-duplicated by id). It works in normal, maximised and fullscreen modes because it is rendered through the player's `overlay` slot. |
| `AttentionDemoPanel` + `AttentionDemo` | Labelled **Demo mode**: simulated scores (threshold 35, 6 s dwell for an auto review point, a dip every 150 s, plus "Simulate attention drop" / "Simulated bookmark"). Everything it writes has `origin: 'simulated'`, is drawn dashed/purple, carries a "Simulated" badge and is excluded from statistics whenever real data exists. "Clear simulated data" removes only demo data. |

Player view modes (normal / minimised / maximised / fullscreen) and the overlay slot live in
`frontend/src/player/`. See `frontend/src/player/README.md`.

## Data rules (from the lead, #1)

- Store input is a plain interface, `AttentionObservation` (`types.ts`): `sessionId, videoId, segmentId,
  evidence {startMediaS,endMediaS} | null, mediaS | null, metric, value | null, scale, valid, origin,
  provenance, threshold?, thresholdVersion?`. **No new wire event** until Annie's score contract is agreed.
- `valid: false`, `value: null`, unknown scales and observations without a media position become **gaps**,
  never zeros.
- Scales: `score_0_100` (higher = attentive) is plotted as is. `loss_0_1` (higher = attention loss, as with
  evaluation `fusion.combinedLoss`) is plotted as `100 × (1 − loss)`. Anything else is stored but not plotted.
- Each `segmentId` is its own line, so rewinding/replaying does not merge viewings. Older viewings of the
  same span are faded. Points are de-duplicated per segment by time.
- **Live mode with no score stream:** call `store.setAvailability({ state: 'unavailable', message:
  'Live score unavailable' })`. The graph then shows only real bookmark markers and that message. It never
  builds a curve from bookmarks and never reuses demo values.
- Persistence: `localStorage["recallroom.attention.v1:<videoId>"]`, holding derived scores, markers and
  stats only. No camera frames, EEG samples or gaze coordinates are stored. Saves are throttled (2 s) and
  flushed on completion. Capped at 20 000 points (oldest dropped). Malformed or other-version data is
  ignored.

## API

```ts
import {
  AttentionTimelineStore, AttentionGraph, AttentionSummary, AttentionInfoIndicator,
  useAttentionLecture, useTimeline, observationFromEvaluation, markerFromBookmark,
} from '../attention';
import '../attention/attention.css';

const [store] = useState(() => new AttentionTimelineStore());   // one per page
useAttentionLecture(store, player);       // open/close on lecture change, duration, completion on `ended`

// Bookmarks: the ReviewClient list is authoritative, so mirror it (removes stale ones, keeps demo ones)
store.syncMarkers(review.bookmarks.filter(b => b.videoId === videoId).map(markerFromBookmark),
                  (m) => !m.id.startsWith('demo-'));

// Scores, where a source exists today (evaluation player snapshot):
const obs = observationFromEvaluation(snapshot, player.getState(), segmentId);
if (obs) store.record(obs);

// Live, no score stream yet:
store.setAvailability({ state: 'unavailable', message: 'Live score unavailable' });
```

Mount points (for `frontend/src/product/App.tsx`, Rohan's):

```tsx
<LecturePlayer client={client} ref={setPlayer} viewMode={mode} onViewModeChange={setMode}
  overlay={<AttentionInfoIndicator store={store} onSeek={(t) => player?.seek(t)} />} />

<aside>                                    {/* sidebar */}
  <AttentionGraph store={store} playback={player} onSeek={(t) => player?.seek(t)} variant="compact" />
</aside>

{showSummary && <AttentionSummary store={store} playback={player} onSeek={(t) => player?.seek(t)}
                                   onClose={() => setShowSummary(false)} />}
```

- `onSeek(timeS, target)`: `target` is `{kind:'marker', marker}`, `{kind:'low', region}` or `{kind:'time'}`.
  For a marker with an end, the dev page uses `player.replayRange(start, end)`. Otherwise it uses `seek`.
- `AttentionTimelineStore.hasSavedSummary(videoId)` lets a page offer "Attention summary (saved)" before
  playback.
- Keep `<LecturePlayer>` mounted in one place and move it with CSS grid areas when minimised. Remounting
  ends the session. `dev/main.tsx` + `dev/dev.css` show the pattern.
- Styles use the `att-` prefix and `var(--ui-*)` tokens with fallbacks. There is no separate design system.

## Files

| File | Purpose |
|---|---|
| `types.ts` | Observation, point, segment, marker, availability and snapshot types. |
| `store.ts` | `AttentionTimelineStore` (bounded, de-duplicated, persisted, `useSyncExternalStore`-compatible) plus pure helpers (`toAttentionScore`, `latestSeries`, `lowRegions`, `timelineStats`). |
| `adapters.ts` | `observationFromEvaluation` (evaluation `fusion.combinedLoss`) and `markerFromBookmark` (`ReviewBookmark`). |
| `hooks.ts` | `useTimeline`, `useRefreshedTimeline` (2-minute line refresh), `useAttentionLecture`. |
| `AttentionGraph.tsx` | SVG graph (no chart library). Close markers are stacked into lanes so each stays clickable. |
| `AttentionSummary.tsx` | Completion summary. |
| `AttentionInfoIndicator.tsx` | ⓘ indicator and popover. |
| `demo.ts`, `AttentionDemoPanel.tsx` | Demo mode, isolated: nothing else imports `demo.ts`. |
| `attention.css` | Styles. |
| `attention.test.ts` | Unit tests (Vitest, node). |
| `dev/` | Reference composition page. Not a product screen; not in the production build. |

## Run the demo

```bash
cd frontend
npm run dev
# open http://127.0.0.1:5173/src/attention/dev/index.html?adapter=synthetic   (no backend needed)
# or without ?adapter=synthetic against the real backend (see frontend/src/player/README.md)
```

1. Open a lecture with "Choose File" (any local video), then press Play.
2. In the Demo mode panel, click "Start simulated data". After a few seconds, click "Simulate attention drop".
   About 6 s later a review point appears: the ⓘ shows on the video and a ● appears on the graph.
3. Click ⓘ to see the details, then click "Go to". Press Esc, or click outside, to close it.
4. Click "Mark moment" (or "Simulated bookmark") to get a ◆ marker and the ⓘ again.
5. Click "Minimise". The player docks above the sidebar graph and keeps playing. Click "Next update" to
   refresh the line now instead of waiting 2 minutes.
6. Try "Maximise" (Esc to leave) and "Fullscreen". The ⓘ and popover work in both.
7. Seek to the end. The summary opens. Reload, open the same file, and "Attention summary (saved)" reopens it.

A synthetic test video can be generated with
`ffmpeg -f lavfi -i testsrc=size=640x360:rate=10 -t 200 -c:v libvpx-vp9 test-results/demo-lecture.webm`.

## Test

```bash
npx vitest run src/attention     # 23 unit tests: scaling, gaps, segments, dedupe, caps, persistence,
                                 # availability, demo isolation, stats, marker lanes, indicator queue
```

Browser check (2026-11-08, headless Chromium, synthetic adapter, 200 s test video). These worked: the ⓘ
appeared on the review point, the popover closed on Esc, playback was not paused, "Go to" and graph
markers seeked, Esc left maximised, the ⓘ and popover showed in real fullscreen, the summary opened at the
end, and it reopened from storage after a reload. That check found overlapping same-time markers, where
one could not be clicked. Fixed with marker lanes.

## Limitations

- **No live score stream yet.** Live mode shows real bookmark markers plus "Live score unavailable".
  Curves exist only from the evaluation adapter or Demo mode.
- `observationFromEvaluation` uses the player's current `mediaS` when the snapshot arrives, so markers can
  be up to ~1 s late. Once the score contract carries mapped evidence intervals, they will be used directly.
- Fullscreen changes the browser chrome. The gaze geometry uses `outerHeight − innerHeight`, so a
  calibration made in windowed mode may be offset in fullscreen (gaze is @ShinJuKim's; flagged, not changed).
- The 2-minute refresh applies to the line only. Markers, the playhead and the ⓘ update immediately.
- **Calibration persistence** (Use saved / Recalibrate / Reset, status, environment change detection) is
  **not in this PR**. It touches `evaluation/player/gaze-runtime.js`, `GazeCalibration.tsx` and
  `frontend/src/focus/*`, which wait on @Seikaro's handoff (#1). A design exists, and Rohan's requirements
  for it are versioned localStorage, explicit Save/Reset, rejecting malformed or incompatible data, a short
  validation before reuse, and no frames or EEG stored.
- Not wired into `frontend/src/product/App.tsx`. That is Rohan's, as agreed.
