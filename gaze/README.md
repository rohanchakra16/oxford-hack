# Webcam Systems — AI Agent Allocation

Owner: @ShinJuKim
Owned folder: gaze/

## Before starting
- Read the root AGENTS.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Prefix posts with [ShinJuKim's Agent], using your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Produce calibrated, timestamped gaze measurements with explicit
quality and performance limits.

The module reports whether the viewer appears to be looking at the lecture video, with explicit
uncertainty and explicit "unavailable" states. It is **coarse webcam gaze, not an eye tracker**, and
makes no claim about attention on its own. Everything runs locally in the browser: no webcam frames
are stored or sent anywhere.

## Tasks
| Task | Status |
|---|---|
| Select and document a reproducible gaze model setup | Done: MediaPipe Face Landmarker, pinned model, served locally (see Run and test) |
| Implement camera permission and camera-loss handling | Done: explicit permission/not-found/in-use/disconnected states, reconnect on device change. Verified: camera denied, and unplugging the camera mid-session |
| Implement calibration and a held-out accuracy check | Done: dot calibration with held-out dots inside and outside the video, per-axis error, plus a scripted look-away accuracy test |
| Map gaze coordinates to video coordinates | Done: normalised video point (0..1 inside), probability of being inside the video, on/off/uncertain decision |
| Handle viewport resize and fullscreen changes | Done: calibration stored in screen space; video content rect re-read every frame. Verified live: window resize, video resize, fullscreen |
| Produce gaze measurements and quality output | Done: shared-contract `gaze_observations` / `gaze_calibration` via `src/contract.ts`, validated against the 0.2.0 JSON Schema |
| Bound processing to maintain responsiveness on the target laptop | Done: 15 fps cap, frames dropped rather than queued, batches ≤ 64. Measured 15 fps at ~28 ms/frame on the dev laptop (see Completion evidence) |
| Document setup, calibration, performance, and limitations | Done: this file |

## Inputs
- Webcam frames (`getUserMedia`, 640×480 ideal, processed at ≤ 15 fps).
- Calibration data (collected by the module's own calibration flow).
- Video viewport geometry from the playback component: the module needs the `<video>` element
  (`getVideoElement`) and reads its `getBoundingClientRect()` on every frame.

## Outputs
- Timestamped gaze measurements.
- Quality diagnostics.
- Camera and tracking status.

Over the wire, only the shared contract (`contracts/`, schemaVersion 0.2.0, owner @rohanchakra16):

| Message | When | Notes |
|---|---|---|
| `gaze_observations` | Batches every ~150 ms (≤ 64 per batch) | `tBrowserFrameMs` = frame capture time; `tBrowserProcessedMs` = processing finished; both `performance.now()`. `videoPoint` normalised to the video rect. |
| `gaze_calibration` | Every state change: `in_progress` → `valid`/`invalid`; `expired` when the head leaves the calibration pose for 10 s | `heldOutErrorNorm` = mean held-out error / video width |

How internal results map to the contract:
- `on_video` / `off_video` → `valid: true`, `insideVideo: true/false`.
- `uncertain` (probability of being inside the video between the two thresholds) → `valid: false`,
  `invalidReasons: ["low_confidence"]`. The contract's `insideVideo` is a yes/no claim we can't make honestly there.
- Eyes closed → `eyes_not_detected`. Camera problems → `camera_unavailable`. No/stale/too-coarse calibration →
  `calibration_missing` / `calibration_invalid`. Face not found → `face_not_detected`.
- `modelConfidence` (valid frames) = probability the reported `insideVideo` is right: P(inside) when inside,
  1 − P(inside) when outside. It comes from the held-out calibration error, so it's only as good as that estimate.

The richer internal types (`src/types.ts`: head pose, per-axis margins, drift diagnostics) are for the
harness and evaluation only.

```ts
import { GazeEngine, ObservationBatcher, toContractObservation, toContractCalibration, gazeProvenance } from "@oxford-hack/gaze";

const engine = new GazeEngine({ sessionId, getVideoElement: () => playerVideoEl });
const prov = gazeProvenance("live", "gaze-0.1.0");
const batcher = new ObservationBatcher((batch) => client.sendGazeObservations(batch));
engine.on("observation", (o) => batcher.push(toContractObservation(o)));
engine.on("calibrationState", (e) => client.sendGazeCalibration(toContractCalibration(e, prov)));
await engine.start();
await engine.calibrate({ show: (p) => drawTarget(p), hide: () => clearTarget() });
```

## Handoffs
| With | About | Status |
|---|---|---|
| @aryanmorarji | Viewport geometry and geometry-change updates | **Agreed** (board, 2026-11-07; PR #16 merged to main). `PlayerHandle.getVideoElement()` returns the same `<video>` for the player's lifetime; wire it as `getVideoElement: () => player.getVideoElement()`. The module reads its rect every frame, so no change events are needed. `.lp-video` is `object-fit: contain`, `object-position: 50% 50%`, no padding/border, matching the module's content-rect assumption; Aryan will post before changing any of that. |
| @Seikaro | Gaze measurements needed for inference | **Agreed** (board, 2026-11-07). Calibrated `screen_gaze` only; valid `insideVideo=false` is usable outside evidence; face/eyes loss and `low_confidence` stay invalid; `modelConfidence` is measurement confidence only; 1 Hz invalid heartbeats become unknown under their gap/coverage rules. Re-sending the active calibration (after a cancelled recalibration) restarts their 4 s gaze window, which they accept as conservative. |
| @rohanchakra16 | Contracts, timestamps, units, transport | Open. Adapter targets contract 0.2.0 and the competing `gaze_observation.v0` schema draft has been removed. Asked on the board (2026-11-07), awaiting an answer: how the frontend should import the gaze module (plus `@mediapipe/tasks-vision`), and optionally a tri-state `insideVideo`. Folder: stays `gaze/` (lead decision 2026-11-07: the `src/` reorganisation, #15, is deferred). Rohan has gaze wiring on his integration to-do list. |
| @Betty505 | Camera/calibration status and onboarding guidance | Open, not yet raised on the board. Provide: camera states, calibration states, guidance text (below), and agree who builds the product's calibration screen (the module supplies the `CalibrationUI` callbacks). |

Onboarding guidance (for @Betty505): sit how you'll sit while watching; face a light source, not a window;
during calibration look at each dot as you'd normally watch (mostly eyes, head may turn a little) and keep your
seat still; recalibrate if you move seats or the module reports calibration expired.

## Boundaries
- Own gaze measurement and calibration.
- @Seikaro owns how gaze contributes to review events.
- @aryanmorarji owns video playback.
- @rohanchakra16 owns cross-clock mapping.

## Completion evidence
| Evidence | Status |
|---|---|
| Tracking demonstrated on the target laptop | Demonstrated on @ShinJuKim's MacBook Pro (Intel Core i5-8257U, built-in FaceTime HD camera, Chrome), including with several teammates on that machine. Confirm again if the demo uses a different laptop |
| Held-out calibration accuracy and limitations documented | Done: scripted accuracy test for one person (history below); teammates tried it informally on the same laptop and it worked well for them too (no scored runs yet). Dot calibration: ~90-100 px held-out RMS in good conditions, vertical error much larger than horizontal; moving dot ~150 px (worse, kept experimental). Accuracy-test history below |

| Tested resize, fullscreen, and camera-loss behaviour | Done (manual, 2026-11-07): window/video resize and fullscreen kept tracking without recalibration; unplugging the camera was reported and recovered; camera denied reported clearly |
| Documented processing performance | Done: 15 fps (the cap) at ~28 ms/frame model time on an Intel Core i5-8257U MacBook Pro in Chrome (GPU delegate where available). That is ~42% of the 66 ms frame budget, so the lecture video stays responsive. Re-check on the demo laptop if different |

### Accuracy-test history
All runs by @ShinJuKim on @ShinJuKim's MacBook (Chrome), 2026-11-07, scripted ~75 s test (`Run accuracy test`), dot calibration
immediately before. Rates are fractions of frames per step after a 2.5 s transition; "uncertain"/unavailable count as not detected.

| Version | Look-away detected | False alarms | On-video confirmed | Balanced acc. | Coverage | Phone / side panel / away |
|---|---|---|---|---|---|---|
| Fixed band, single margin | 66% | 20% | 33% | 73% | 84% | 89% / 95% / 13% |
| + smoothing, diagnostics | 49% | 0% | 35% | 75% | 87% | 99% / 29% / 20% (head-turn staleness bug) |
| + depth-based distance (bug fix) | 71% | 7% | 0% | 82% | 100% | 100% / 14% / 100% |
| + per-axis margins, dots outside video | 85% | 2% | 14% | 91% | 100% | 99% / 56% / 100% |
| **+ probability decision (current)** | **97%** | **0%** | **88%** | **98%** | **98%** | **95% / 95% / 100%** |

Caveats: one person, one desk, one run per version; the side-panel step is near calibration dots, so it is
optimistic. Right after looking down at the phone, the vertical estimate stays low for a few seconds (head stays
tilted while the eyes return), giving extra `uncertain` frames (current run: video-2 73% vs. 91%/99% for the other
video steps), not false alarms. Next: runs by other teammates and on the demo laptop.

## Run and test
Requires Node 22+ (verified with 22.23.4). From `gaze/`:

```bash
npm install
npm run setup        # once: copies MediaPipe WASM, downloads the pinned face model into public/ (git-ignored)
npm test             # 65 unit tests: features, calibration, probability decision, letterbox geometry, smoothing, accuracy scoring, contract adapter, capture recorder, startup asset checks
npm run typecheck
npm run dev          # harness at http://localhost:5174; open in Chrome and allow the camera
```

Model setup: `@mediapipe/tasks-vision` 1.2.2 (Apache-2.0); model
`face_landmarker/float16/1/face_landmarker.task` from Google's model storage. Both are served from `public/`, so
the demo works offline after `npm run setup`. GPU delegate with CPU fallback.

Startup errors. Any app that embeds the engine must serve `gaze/public/` (model at `/models`, WASM at
`/mediapipe/wasm`, or pass `modelAssetPath` / `wasmBasePath`). The files are git-ignored, so every checkout and
worktree that serves the app needs its own `npm --prefix gaze ci && npm --prefix gaze run setup`.
`engine.start()` loads the model first, before asking for the camera:
- **Model files missing or wrong:** it throws a `GazeStartupError` with `kind: "assets_missing"`, naming each
  bad URL (HTTP error, the dev server's HTML fallback, wrong file signature) and the setup command.
- **Files fine but MediaPipe can't create the model** (WASM/WebGL/browser): `kind: "model_load_failed"`.
- **Camera problems are not thrown.** They appear in `engine.camera.state` as `status: "error"` with a
  `CAMERA_*` reason and a message saying what to do (permission denied, camera busy, no camera, needs
  https/localhost).

`engine.modelState` (and the `model` event) reports `loading` / `ready` / `error`, separately from the camera.
Calling `start()` again retries whichever step failed.

Harness (`index.html`), in order:
1. **Start camera.** The preview shows eye corners (blue) and iris centres (red).
2. **Calibrate** (~30 s): 11 dots inside the video plus up to 6 beyond its edges where the window has room;
   2 inside and up to 2 outside dots are held out. Shows held-out RMS overall and per axis, quality per axis, and
   per-axis error σ. **Moving dot (experimental)** is kept for comparison only; it tested worse.
3. **Run accuracy test** (~75 s): scripted look at video / phone / side panel / away from screen. Reports
   look-away detection, false alarms, balanced accuracy, coverage, the main reason for unavailable frames,
   and drift diagnostics per step.
4. **Shrink video** to test geometry changes.
5. **Record** (press it *before* calibrating and running the accuracy test), then **Stop** and download:
   - **Download contract capture** → `<session>.gaze-capture.jsonl`, for @Seikaro / @rohanchakra16 (format below).
   - **Download internal JSONL** → `<session>.internal.jsonl`, with head pose, per-axis error and diagnostics.
   Neither contains images. Don't commit captures of people to Git (`*.jsonl` is git-ignored here).

### Gaze capture format (`oxford-hack-gaze-capture`, v1)
Real webcam output in the shared contract, for replaying through inference and the platform instead of synthetic
data. It is *not* the backend's `oxford-hack-recording` replay format, which records a whole session on the backend
clock; the harness has no backend session. A capture holds browser-side gaze messages on the **browser clock**, plus
ground-truth labels from the accuracy test, so it can be spliced into a recording or fed to the inference adapter
after clock mapping. Every envelope validates against `contracts/schema` 0.2.0.

```text
line 1:  {"format":"oxford-hack-gaze-capture","formatVersion":1,"schemaVersion":"0.2.0","runKind":"live",
          "producer":"gaze-webcam-mediapipe","producerVersion":…,"sessionId":…,"createdAt":…,"clock":…,"description":…}
message: {"kind":"message","tBrowserMs":…,"message":{<gaze_calibration | gaze_observations envelope>}}
label:   {"kind":"label","phaseId":"phone","expected":"off_video","startBrowserMs":…,"endBrowserMs":…,
          "scoredFromBrowserMs":…,"instruction":…}
```
`scoredFromBrowserMs` skips the 2.5 s transition the accuracy test ignores. The capture starts with the
calibration in force when recording began, so it is self-contained.

## How it works
| Stage | Method |
|---|---|
| Features | Head yaw/pitch/roll and depth from the face transform; iris position within each eye opening; eye openness from blink blendshapes. |
| Calibration | Ridge regression from `[yaw, pitch, iris_x, iris_y]` to screen px on per-dot medians. Held-out error per dot, overall and per axis; quality judged per axis against the video's size along it. |
| Smoothing | 1 s rolling median of the screen estimate, then a 180 ms time-based moving average; the estimate is held through partial blinks (eye openness < 0.6) and restarted after gaps (~0.7 s lag). Replaying logged main-app frames, this cut frame-to-frame jumps over 120 px from 6.4% to 2.9% (was 700 ms median only; the accuracy-test history below used that). |
| Region | P(inside video), treating the held-out RMS on each axis as the error's standard deviation (floor 25 px) with independent Gaussian errors. **Asymmetric thresholds:** `off_video` only if P ≤ 7% (strict, since false alarms trigger wrong suggestions; equivalent to the earlier 1.5σ band), `on_video` if P ≥ 40% (lenient, since a missed "off" costs little; lowered from 60% after main-app runs showed ~31% of on-video frames left `uncertain`), else `uncertain`. Configurable via `onThreshold` / `offThreshold`. The earlier fixed band was replaced because with large vertical error it left no point that could count as on-video. |
| Staleness | Head moves >12% of the frame or distance changes >25% for >1.5 s → `CALIBRATION_STALE`; after 10 s → expired. Distance uses the model's 3D depth, so head turns don't count as moving. |
| Unavailability | Explicit reasons; a 1 Hz heartbeat when no frame is processed, so silence never means "fine". |

## Known limitations
- Laptop webcams give **coarse** gaze, much worse vertically than horizontally. The meaningful signal is
  "clearly looking away" (phone, turning away), not where on the slide someone looks.
- Turning far away can lose the face entirely (`face_not_detected`); whether that counts as looking away is
  @Seikaro's call.
- Looking down at notes reads as off-video.
- Glasses glare, backlighting and low light degrade iris tracking.
- Viewport-to-screen conversion approximates the browser toolbar height; docked devtools can offset it.

## Completion post
Post the branch/PR, changes, tests, limitations, and next handoff
on Message Board issue #1.

Status: not posted yet (pending the completion evidence above).
