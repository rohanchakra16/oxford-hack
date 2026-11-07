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
| Implement camera permission and camera-loss handling | Done: explicit permission/not-found/in-use/disconnected states, reconnect on device change. Camera-denied path verified in browser; live unplug not yet tested |
| Implement calibration and a held-out accuracy check | Done: dot calibration with held-out dots inside and outside the video, per-axis error, plus a scripted look-away accuracy test |
| Map gaze coordinates to video coordinates | Done: normalised video point (0..1 inside), on/off/uncertain with per-axis error margins |
| Handle viewport resize and fullscreen changes | Implemented (calibration stored in screen space; video rect re-read every frame). **Not yet tested live** |
| Produce gaze measurements and quality output | Done: shared-contract `gaze_observations` / `gaze_calibration` via `src/contract.ts`, validated against the 0.1.0 JSON Schema |
| Bound processing to maintain responsiveness on the target laptop | Implemented: 15 fps cap, frames dropped rather than queued, batches ≤ 64. **Per-frame cost not yet measured on the target laptop** |
| Document setup, calibration, performance, and limitations | This file; performance numbers pending |

## Inputs
- Webcam frames (`getUserMedia`, 640×480 ideal, processed at ≤ 15 fps).
- Calibration data (collected by the module's own calibration flow).
- Video viewport geometry from the playback component: the module needs the `<video>` element
  (`getVideoElement`) and reads its `getBoundingClientRect()` on every frame.

## Outputs
- Timestamped gaze measurements.
- Quality diagnostics.
- Camera and tracking status.

Over the wire, only the shared contract (`contracts/`, schemaVersion 0.1.0, owner @rohanchakra16):

| Message | When | Notes |
|---|---|---|
| `gaze_observations` | Batches every ~150 ms (≤ 64 per batch) | `tBrowserFrameMs` = frame capture time; `tBrowserProcessedMs` = processing finished; both `performance.now()`. `videoPoint` normalised to the video rect. |
| `gaze_calibration` | Every state change: `in_progress` → `valid`/`invalid`; `expired` when the head leaves the calibration pose for 10 s | `heldOutErrorNorm` = mean held-out error / video width |

How internal results map to the contract:
- `on_video` / `off_video` → `valid: true`, `insideVideo: true/false`.
- `uncertain` (estimate within the calibration error band of the video edge) → `valid: false`,
  `invalidReasons: ["low_confidence"]`. The contract's `insideVideo` is a yes/no claim we can't make honestly there.
- Eyes closed → `eyes_not_detected`. Camera problems → `camera_unavailable`. No/stale/too-coarse calibration →
  `calibration_missing` / `calibration_invalid`. Face not found → `face_not_detected`.
- `modelConfidence` is always `null` (no meaningful per-frame confidence yet).

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
| @aryanmorarji | Viewport geometry and geometry-change updates | Open. Proposal: the player passes its `<video>` element; the module reads its rect every frame, so no change events are needed. Need: agreement, and whether the video can be letterboxed (then we need the content rect, not the element rect). |
| @Seikaro | Gaze measurements needed for inference | Open. Available: `insideVideo` with `low_confidence` for uncertain, reasons per frame. Measured: phone/away detected reliably, on-video mostly `uncertain` (see Completion evidence). Ask: is `valid=false, low_confidence` workable, or do you want a tri-state? |
| @rohanchakra16 | Contracts, timestamps, units, transport | Adapter targets contract 0.1.0 and the competing `gaze_observation.v0` schema draft has been removed. Possible requests: allow a tri-state or uncertainty on `insideVideo`; per-axis held-out error on `gaze_calibration`. Also: AGENTS.md assigns `gaze/`, but `docs/frontend-integration.md` proposes `frontend/src/gaze/`. Which one? |
| @Betty505 | Camera/calibration status and onboarding guidance | Open. Provide: camera states, calibration states and guidance text (below). |

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
| Tracking demonstrated on the target laptop | Tracking demonstrated on @ShinJuKim's MacBook (Chrome). Target/demo laptop still to confirm |
| Held-out calibration accuracy and limitations documented | Partly. Dot calibration: ~90-100 px held-out RMS in good conditions; moving dot ~150 px (worse, kept experimental). Accuracy test (run 2026-11-07, before per-axis margins/outside dots): phone 100%, away from screen 100%, side panel 14%, false alarms 7%, on-video confirmed 0% (mostly `uncertain`, vertical error dominates). Re-run after the latest changes pending |
| Tested resize, fullscreen, and camera-loss behaviour | Camera denied: verified. Resize, fullscreen, camera unplug: **pending** (harness has a "Shrink video" toggle) |
| Documented processing performance | **Pending**: read ms/frame and fps from the harness header chip on the target laptop |

## Run and test
Requires Node 22+ (verified with 22.23.4). From `gaze/`:

```bash
npm install
npm run setup        # once: copies MediaPipe WASM, downloads the pinned face model into public/ (git-ignored)
npm test             # 42 unit tests: features, calibration, per-axis margins, region, smoothing, accuracy scoring, contract adapter
npm run typecheck
npm run dev          # harness at http://localhost:5174; open in Chrome and allow the camera
```

Model setup: `@mediapipe/tasks-vision` 1.2.2 (Apache-2.0); model
`face_landmarker/float16/1/face_landmarker.task` from Google's model storage. Both are served from `public/`, so
the demo works offline after `npm run setup`. GPU delegate with CPU fallback.

Harness (`index.html`), in order:
1. **Start camera.** The preview shows eye corners (blue) and iris centres (red).
2. **Calibrate** (~30 s): 11 dots inside the video plus up to 6 beyond its edges where the window has room;
   2 inside and up to 2 outside dots are held out. Shows held-out RMS overall and per axis, quality per axis, and margins.
   **Moving dot (experimental)** is kept for comparison only; it tested worse.
3. **Run accuracy test** (~75 s): scripted look at video / phone / side panel / away from screen. Reports
   look-away detection, false alarms, balanced accuracy, coverage, the main reason for unavailable frames,
   and drift diagnostics per step.
4. **Shrink video** to test geometry changes. **Record → Download JSONL** exports messages (no images) as fixtures.

## How it works
| Stage | Method |
|---|---|
| Features | Head yaw/pitch/roll and depth from the face transform; iris position within each eye opening; eye openness from blink blendshapes. |
| Calibration | Ridge regression from `[yaw, pitch, iris_x, iris_y]` to screen px on per-dot medians. Held-out error per dot, overall and per axis; quality judged per axis against the video's size along it. |
| Smoothing | 700 ms rolling median of the screen estimate, restarted after gaps (~0.35 s lag). |
| Region | Per-axis uncertainty band of ±max(40 px, 1.5 × held-out RMS on that axis) around the video edge → `on_video` / `uncertain` / `off_video`. |
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
