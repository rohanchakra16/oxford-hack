# Frontend integration: the Person 4 / Person 5 boundary

> **Status: PROPOSED.** Written by Person 5. Person 4 hasn't agreed to it yet. Until they do, Person 4 can start isolated UI work in `src/frontend/src/product/` against the synthetic adapter.

## 1. Who owns what

| Path | Owner | Notes |
|---|---|---|
| `src/contracts/` | P5 | Schema bundle and fixtures, generated from `src/platform/src/oxford_hack/contracts/`. Never edit by hand. |
| `src/frontend/src/contracts/` | P5 | Generated TS types (`generated/`) and runtime validator (`validate.ts`). |
| `src/frontend/src/integration/` | P5 | **Public API for product code.** Live and synthetic adapters, store, playback reporter, React hooks. |
| `src/frontend/src/diagnostics/` | P5 | Developer diagnostics page at `/diagnostics`. Not a product screen. |
| `src/frontend/src/main.tsx` | P5 (shared) | Entry wiring only: routes `/diagnostics` and everything else to `product/App`. |
| `src/frontend/src/product/` | **P4** (see below) | All product screens, styling, layout, accessibility, player, transcript, bookmark timeline, onboarding, device-status presentation. `App.tsx` is a placeholder to replace. |

**Matching `AGENTS.md` §4.** The lead's table splits P4's work between two people:
- `@aryanmorarji`: player, local media, telemetry capture, transcript.
- `@Betty505`: review timeline and recovery, onboarding, shared components, styles, and the composition root `src/frontend/src/App.tsx`.

`AGENTS.md` records frontend ownership under `src/frontend/src/`, including `player/`, `telemetry/`, `transcript/`, `review/`, `recovery/`, `onboarding/`, `components/` and `styles/`. The composition currently lives in `src/frontend/src/product/App.tsx`. Any later move to `src/frontend/src/App.tsx` requires a separate owner handoff and entry-point update; this repository cleanup preserves the existing composition and all product files.

"Playback telemetry" is split too:
- Aryan's player *captures* media element events and forwards them with `reportMediaEvent` or `attachMediaElement`.
- P5's `PlaybackReporter` turns them into contract `PlaybackState` messages, owning segment ids, sequencing and heartbeats, because segment semantics are part of the timing contract.
| `src/frontend/src/gaze/` (to be created) | P2 | Webcam gaze. Sends through `client.sendGazeObservations`. |
| `src/frontend/e2e/infra/` | P5 | Infrastructure browser tests. |
| `src/frontend/e2e/product/` (to be created) | **P4** | Product-flow browser tests. |
| `src/frontend/package.json`, `package-lock.json`, `playwright.config.ts`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `.github/` | P5 (shared) | Request changes as described in §7. |

Lint enforces part of this: product code can't use the `WebSocket` global (`no-restricted-globals`). The only socket lives in `src/integration/live/`.

## 2. The public interface

Import only from `src/integration/index.ts`. The full definitions, with comments, are in `src/integration/types.ts`.

```ts
interface ReviewClient {
  readonly kind: 'live' | 'synthetic';
  getSnapshot(): ReviewClientSnapshot;            // immutable, new object per change
  subscribe(listener: () => void): () => void;    // for useSyncExternalStore
  onEvent(listener: (e: ReviewClientEvent) => void): () => void; // bookmark_added, session_started/ended, error
  connect(): void; disconnect(): void; dispose(): void;
  startSession(o: { videoId; runKind: 'live' | 'simulated'; sensors: { eeg; gaze }; mediaDurationS }): void;
  endSession(reason?): void;
  reportMediaEvent(event: MediaEventName, media: MediaSnapshot): void;  // playback telemetry
  markBookmark(mediaTimeS: number): string;                             // user action
  sendFeedback(bookmarkId, action: 'replay' | 'dismiss' | 'move_earlier' | 'rated_useful' | 'rated_not_useful', mediaTimeS | null): void;
  sendGazeObservations(obs: GazeObservation[]): void;                   // Person 2
  sendGazeCalibration(cal): void;                                       // Person 2
}

interface ReviewClientSnapshot {
  kind;                       // 'live' | 'synthetic': always show synthetic mode in the UI
  connection: { state: 'idle' | 'pairing_required' | 'connecting' | 'connected' | 'reconnecting' | 'incompatible' | 'closed';
                detail: string; backendInstanceId; backendRestarted: boolean; reconnectAttempt: number };
  session: { sessionId; videoId; runKind: 'live' | 'replay' | 'simulated'; config: SessionConfig } | null;
  sensors: SensorStatus | null;      // src/eeg/gaze: disabled|unavailable|connecting|warming_up|ok|degraded|lost; mode; automaticSuggestions
  eligibility: PlaybackEligibility | null;
  clock: ClockStatus | null;         // diagnostics
  bookmarks: readonly ReviewBookmark[];   // AUTHORITATIVE, sorted by suggestedMediaS
  rejections: readonly CandidateRejected[]; // diagnostics only
  errors: readonly ClientError[];    // last 50
}
```

Message payload types (`ReviewBookmark`, `SensorStatus`, …) are generated from the shared schema. Don't redeclare them.

### Example

```tsx
import { useState } from 'react';
import { createReviewClient, useReviewConnection, useReviewSnapshot, attachMediaElement } from '../integration';

export function Player({ videoId, src }: { videoId: string; src: string }) {
  const [client] = useState(() => createReviewClient()); // ?adapter=synthetic for no backend
  useReviewConnection(client);                            // connect on mount, disconnect on unmount
  const snap = useReviewSnapshot(client);

  const onVideo = (el: HTMLVideoElement | null) => {
    if (!el) return;
    client.startSession({ videoId, runKind: 'live', sensors: { eeg: true, gaze: true }, mediaDurationS: null });
    const detach = attachMediaElement(client, el);        // or call client.reportMediaEvent yourself
    return () => { detach(); client.endSession('video_changed'); };
  };

  return (
    <>
      {snap.kind === 'synthetic' && <p role="status">Synthetic data</p>}
      <video ref={onVideo} src={src} controls />
      <ul>{snap.bookmarks.map((b) => <li key={b.bookmarkId}>{b.source} at {b.suggestedMediaS.toFixed(1)} s</li>)}</ul>
    </>
  );
}
```

(Ref callbacks that return cleanup functions need React 19, which this repo uses.)

## 3. Identifiers and state: one owner each

| Item | Created by | Notes |
|---|---|---|
| `videoId` | **P4** | Stable id for the lecture (e.g. file hash or catalogue id). One session per video. |
| `sessionId` | backend (P5) | Created on `startSession`; product code only reads it. |
| `segmentId` | integration layer (P5, `PlaybackReporter`) | New id whenever frames start advancing after any interruption. P4 only forwards media events. |
| `telemetrySeq`, `seq`, `messageId` | integration layer (P5) | |
| `eventId` / `bookmarkId` (experimental) | P3 / backend | `bookmarkId = "bm-" + eventId`, stable across retransmits. |
| `bookmarkId` (manual) | integration layer | Returned by `markBookmark`. |
| Bookmark list | **backend, mirrored in `snapshot.bookmarks`** | Authoritative. Don't keep a separate copy that can drift. |
| UI-only bookmark state | **P4** | Selection, hover, "dismissed in this view", "moved earlier by N sentences", the replay destination. Key it by `bookmarkId` and derive from `snapshot.bookmarks`. Tell the backend what the user did through `sendFeedback` (for evaluation). The backend doesn't delete bookmarks. |

## 4. Timestamps: who maps what

1. **Cross-clock mapping (EEG/LSL clock → backend clock → browser clock → media time) belongs to P5 alone**, in the backend (`timing/`). Product code never converts clocks. The synthetic adapter doesn't either. It derives fake times straight from the reported media position.
2. The backend sends `ReviewBookmark.suggestedMediaS`: a conservative suggestion (evidence start minus `mapping.leadInS`). It isn't a measured lapse onset. `evidenceMedia` keeps the evidence interval in media seconds.
3. **The transcript-adjusted replay destination is P4's.** For example, the start of the sentence containing `suggestedMediaS`, or earlier after "move earlier". It's UI state derived from `suggestedMediaS` plus P4's transcript. The backend sends `transcriptContext: null` and never chooses sentence boundaries.

## 5. Lifecycle, cleanup and reconnection

- Create one client per page (`useState(() => createReviewClient())`). Call `connect()` once: `useReviewConnection` does it on mount, with `disconnect()` on unmount. Call `dispose()` when the client is discarded for good.
- `subscribe` and `onEvent` return unsubscribe functions. Always call them in effect cleanup.
- Call `startSession` when a video is chosen and `endSession('video_changed')` before switching videos. `startSession` also ends a current session.
- Forward **every** media element event: `attachMediaElement` does it, or call `reportMediaEvent` yourself. `timeupdate` drives 1 s heartbeats. Without it the backend marks telemetry stale and suggestions stop, which is the intended, safe behaviour.
- Live adapter connection states: `connecting` → `connected`. On a network loss it goes to `reconnecting`, with capped backoff of 0.25 s to 5 s, and gives up after 120 attempts. On reconnect it repeats the handshake and asks to resume:
  - **Session resumed** (backend still running): the bookmark list is replaced from a snapshot. Playback telemetry resumes with a new segment.
  - **Backend restarted**: `connection.backendRestarted = true`. The old session and its bookmarks are cleared. The client starts a new session for the same video automatically.
- `pairing_required`: the page has no launch token. The user opens the pairing link printed by `npm run dev`.
- `incompatible`: frontend and backend schema versions differ. Show a clear message; don't retry.
- Missing or failed sensors show up as `sensors.eeg.state` / `sensors.gaze.state` (`unavailable`, `lost`, `degraded`, …). **These aren't possible lapses.** Present them separately from bookmarks. When `sensors.automaticSuggestions` is false, show manual recovery only.
- Detection never pauses or seeks playback. The UI decides everything visible.

## 6. Synthetic mode (no backend, no EEG, no webcam)

```bash
cd src/frontend
npm ci
npm run dev
# open http://127.0.0.1:5173/?adapter=synthetic   (or set VITE_REVIEW_ADAPTER=synthetic)
```

- `snapshot.kind === 'synthetic'`, `runKind: 'simulated'`, `detectorId: 'synthetic-adapter'`, and the connection detail starts with "SYNTHETIC". Always show this in the UI.
- Default scenario: one automatic bookmark every 25 s of continuous playback, gaze lost at 60 to 75 s, EEG lost at 120 to 135 s. Configure it with `new SyntheticReviewClient({ scenario: { … } })`.
- Every synthetic payload is checked against the shared schema before use, so a fixture can't drift from the contract.
- For deterministic component tests, pass `new ManualTimers()` and call `timers.advance(ms)`. `simulateConnectionLoss(ms)` exercises reconnect UI.

## 7. Changing the interface or shared files

- **Interface or contract changes** (anything in `src/integration/types.ts`, `index.ts` or `src/platform/src/oxford_hack/contracts/`): open a small PR with the `interface-change` label, or post on the team board, and say why. P5 implements it in both adapters and the backend, then regenerates types (`npm run contracts:generate`). Contracts use exact-match versions, so every contract change bumps `SCHEMA_VERSION`.
- **Shared setup files** (dependencies, lockfile, Vite/TS/ESLint/Playwright config, CI): P4 may open a PR that edits them. Keep it to the minimal change, say why in the description, and P5 reviews. For adding a dependency, `npm install <pkg>` in `src/frontend/` plus the lockfile diff is enough. Don't wait on P5 for anything inside `src/product/`.
- Until this document is agreed, treat everything above as a proposal and raise disagreements on the board.

## 8. Open decisions (need P4's agreement before integration)

1. Is `attachMediaElement` acceptable, or will the player call `reportMediaEvent` itself? (One or the other, never both.)
2. How `videoId` is derived for local files and URLs.
3. The replay-destination rule (sentence start versus a fixed lead-in), and whether "move earlier" steps by sentence.
4. Whether product browser tests run against the synthetic adapter (fast) or the live backend in simulated mode (slower, more realistic).
5. Whether bookmarks should survive a backend restart. Currently they don't.
