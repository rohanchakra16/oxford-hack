# Playback and Transcript — Player

Owner: @aryanmorarji (Person 4, playback). Issue: #3. Branch: `person4/video-player`.

Status: **Milestone 1 (standalone local-video player) implemented on this branch. Not merged.**
The interface below is **PROPOSED** until @Betty505 agrees it on the board (#1).

## Location

The allocation lists `frontend/player/`, `frontend/telemetry/`, `frontend/transcript/`.
This code lives in `frontend/src/player/`, following `docs/frontend-integration.md` §1, because
`tsconfig.app.json` only compiles `src/`. Confirmation requested from the lead on #1.

## What it does

- Opens a lecture video **from this device** (file picker + object URL). The file is never uploaded
  or sent anywhere; only its `videoId` reaches the integration layer.
- Play/pause (button or click on the video), seek bar, `current / duration`, mute, volume, speed
  (0.75×–2×).
- States: no lecture, loading, buffering, and readable errors for non-video files, empty files,
  unsupported formats and damaged files.
- Forwards every media element event to the shared `ReviewClient` with `attachMediaElement`
  (Person 5's helper). The player does **not** call `reportMediaEvent` itself and does **not** build
  `PlaybackState` messages; segment ids, sequencing and heartbeats are Person 5's `PlaybackReporter`.
- Starts one session per video: `endSession('video_changed')` then `startSession(...)` before the new
  source is set, so `loadedmetadata` reaches the new session. `endSession('page_closing')` on unmount.
- Exposes a `PlayerHandle` for the review UI and transcript: state, `seek`, `replayRange`.

Transcript: see `src/transcript/README.md`. Not done yet (see #3): video geometry for gaze, Panopto (`docs/panopto.md`).

## Interface (PROPOSED)

```ts
import { LecturePlayer, type PlayerHandle } from '../player';

const [player, setPlayer] = useState<PlayerHandle | null>(null);
<LecturePlayer client={client} ref={setPlayer} session={{ runKind: 'live', sensors: { eeg: true, gaze: true } }} />
```

| Member | Meaning |
|---|---|
| `getState(): PlaybackStatus` | Immutable snapshot; same object until something changes. |
| `subscribe(listener): () => void` | For `useSyncExternalStore(player.subscribe, player.getState)`. |
| `seek(timeS)` | Jump to `timeS`, clamped to `[0, duration]`. Throws `RangeError` if not finite. Cancels any replay. |
| `replayRange(startS, endS): Promise<void>` | Seek to `startS`, play, pause at `endS`. Rejects with `RangeError` if not finite or `endS <= startS` after clamping. Another seek cancels it; pausing does not. |
| `cancelReplay()` | Stop treating the range as a replay (does not pause). |
| `play()`, `pause()` | As on `HTMLMediaElement`. |
| `getLecture(): { videoId, fileName } \| null` | Currently loaded lecture. |
| `getVideoElement(): HTMLVideoElement` | The `<video>` element, for gaze geometry only (@ShinJuKim reads its rect each frame). Same element for the player's lifetime. Do not control playback through it; use `seek`/`play`/`pause`. |
| `onMediaEvent(listener)` | Raw media events with the status after each. Diagnostics/logging only. |

`PlaybackStatus`: `mediaTimeS`, `durationS` (null until known), `paused`, `ended`, `seeking`,
`buffering`, `playbackRate`, `volume`, `muted`, `replay: { startS, endS } | null`.

Props: `client` (required, one per page), `session` (`runKind`, `sensors`; composition decides),
`ref`, `onLectureChange(lecture | null)`.

The handle is `null` until the `<video>` has mounted. With React 19, pass a state setter as `ref`
(as above) to receive it.

### Video element layout (gaze depends on this)
`.lp-video` uses `object-fit: contain` (centred, default `object-position`), with no padding or border,
so letterbox bars sit inside the element rect. Gaze computes the content box from this. Any change
must be posted on the board (#1) for @ShinJuKim first.

### Units and timing

- **All times are media seconds** (`HTMLMediaElement.currentTime`), as floats. No milliseconds, no
  wall-clock, no clock conversion. Cross-clock mapping is Person 5's (`docs/frontend-integration.md` §4).
- At 2× speed, one wall-clock second advances media time by two seconds; `replayRange` ranges are in
  media time, so a 10 s range takes 5 s at 2×.
- `replayRange` detects the end with `timeupdate` (about 4 Hz), so playback can run up to ~0.25 s
  (× rate) past `endS`. Observed in Chromium: range 50–53 s stopped at 53.10 s.
- The replay **destination** (sentence start, "move earlier") is chosen by the caller from
  `ReviewBookmark.suggestedMediaS` plus the transcript; the player just plays the range it is given.

### videoId for local files (PROPOSED on #1)

`"local-" + first 16 hex of SHA-256(name | size | lastModified)`. Stable for the same file on the
same device, instant (does not read contents), matches the contract pattern
`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`. Renaming or re-downloading a file gives a new id.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Public exports. Import only from here. |
| `LecturePlayer.tsx` | React component: file loading, controls, states, session lifecycle, telemetry attachment. |
| `controller.ts` | `PlayerController`: framework-free state/commands for one media element (seek, replay, rate, volume). |
| `localMedia.ts` | File checks, `localVideoId`, media error messages, time formatting. |
| `player.css` | Player-only styles, prefixed `lp-` (shared styles are @Betty505's). |
| `fakeMedia.ts` | Test double for `HTMLMediaElement` (Vitest runs in Node, no DOM). |
| `*.test.ts` | Unit tests and the telemetry contract test. |
| `dev/` | Dev harness page. Not a product screen; not in the production build. |

## Run

Requires Node ≥ 22.12 (`.nvmrc`: 22).

```bash
cd frontend
npm ci
npm run dev
```

Open the dev harness (synthetic data, no backend or sensors):

<http://127.0.0.1:5173/src/player/dev/index.html?adapter=synthetic>

It shows the player and transcript side by side, the live `PlaybackStatus`, a media event log, a
stand-in for the review UI (`seek(30)`, `replayRange(start, end)`, and Replay / Move earlier for each
suggested review point, starting at a sentence when a transcript is open), and a **SYNTHETIC DATA** label. With the synthetic adapter a suggested review point appears after about
25 s of continuous playback.

Use only videos you are allowed to use. **Never commit lecture media or transcripts.**
To make a test video: `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=120 -f lavfi -i sine=frequency=440:duration=120 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest test-lecture.mp4`

## Test

```bash
cd frontend
npm test            # all Vitest suites (player: src/player/*.test.ts)
npx vitest run src/player
npm run typecheck
npm run lint
npm run build       # confirms the harness is excluded from the product build
```

`telemetry.test.ts` drives a fake media element through `attachMediaElement` → Person 5's
`PlaybackReporter` and validates **every** `playback_state` message against the shared schema,
plus the "segmentId set iff playing" rule. It checks: a seek ends a segment and starts a new one,
paused time is never reported as playing, a rate change starts a new segment, replay produces
seek → segment → heartbeats → pause, and media errors are reported.

### Verified (2026-11-07, Node 22.23, Chromium, synthetic adapter)

- `npm test`: 84 passed (28 player, 56 existing). `typecheck`, `lint`, `build`: clean.
- Manual, in the dev harness: empty state; `notes.pdf` rejected with a message; a corrupt `.mp4`
  shows "cannot play this video format"; a valid 2 min MP4 loads (`0:00 / 2:00`) and the previous
  error clears; play, 2× speed, `seek(30)`, `replayRange(50, 53)` (paused at 53.10 s), and Replay on
  a synthetic suggestion (0:21–0:36). Each new file starts a new session (`syn-ses-N`).

- Manual, by @aryanmorarji on Windows, Microsoft Edge, synthetic adapter: a real downloaded lecture
  (MP4, ~350 MB, ~2 h) loads and plays with no errors. Checked: duration shown in h:mm:ss, seeking near
  the end, 1.5× and 2×, `replayRange(600, 615)`, Replay on a synthetic suggestion, pause/resume, and
  opening a second lecture (new session).

Not verified: live backend, Firefox/Safari, non-H.264 codecs (HEVC/H.265, some MKV), React component
tests (needs a DOM test library: shared config, Person 5 review).

## Decisions and assumptions

- `attachMediaElement`, not `reportMediaEvent` (one or the other, never both). Posted on #1.
- No native `controls` attribute: all seeks go through the controller, so replay cancellation is
  reliable. Keyboard shortcuts are not implemented yet.
- Listener order matters: the controller is created before `attachMediaElement`, so at the end of a
  replay the pause is reported instead of one extra heartbeat.
- Selecting a corrupt file still starts a session for it; telemetry then reports `error`.
- The dev harness is a temporary stand-in. Mounting in the product app is @Betty505's call
  (asked on #1); `src/product/App.tsx` and `src/main.tsx` are untouched.

## Handoffs

- @Betty505: agree `PlayerHandle` and how the player is mounted; the replay-destination rule.
- @ShinJuKim: video geometry (`viewportCssPx`, `videoRectCssPx`) and update events.
- @rohanchakra16: telemetry units/timing (media seconds, forwarding via `attachMediaElement`).
