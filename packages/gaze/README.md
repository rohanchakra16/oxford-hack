# @oxford-hack/gaze: webcam workstream (Person 2)

Webcam head-pose and **coarse** gaze estimation for the lecture review player. It reports whether the
viewer appears to be facing the lecture video, with explicit uncertainty and explicit "unavailable" states.
It is **not an eye tracker** and makes no claim about attention on its own.

Everything runs locally in the browser. No webcam frames are stored or sent anywhere; only the derived
numbers below leave the module.

## Quick start

```bash
npm install
npm run setup      # copies the MediaPipe WASM runtime + downloads the face model into public/ (once)
npm run dev        # harness at http://localhost:5174 — open it in Chrome (needs camera permission)
npm test           # unit tests (features, calibration fit, region logic, staleness, summaries)
npm run typecheck
```

The model and WASM are served from `public/`, so the demo works offline once `npm run setup` has run.

## Harness

`index.html` is a standalone dev tool:

1. **Start camera.** The preview shows eye corners (blue) and iris centres (red).
2. **Calibrate.** Sit how you'll sit while watching. Look at the targets the way you'd normally watch:
   mostly with your eyes, letting your head turn a little. Keep your seat position still.
   - **Calibrate (default):** 11 still dots, 9 fitted and 2 held out. Uses head angle and iris position.
   - **Moving dot (experimental):** follow a moving dot for ~24 s; adds face position features, with blocked
     hold-out and an eye-lag search. In testing it did *worse* (~150 px vs. ~90-100 px held-out error, and it felt
     worse live), probably because following a moving dot changes how people move their head and eyes compared
     with normal watching. Kept only for comparison.
   Both report held-out RMS error (per held-out dot or block) and a quality tier.
3. Watch the gaze dot and the video outline (green on, red off, amber uncertain).
4. **Run accuracy test (~75 s).** This is the number that matters for the product. A banner (with a beep at each change)
   asks you to alternate between watching the video and looking away: at your phone, at the side panel, and away
   from the screen. The first 2.5 s of each step is ignored. It reports:
   - **look-away detected:** fraction of look-away frames reported `off_video`
   - **false alarms:** fraction of on-video frames reported `off_video` (these would trigger wrong suggestions)
   - **on-video confirmed**, **balanced accuracy** (50% = chance) and **coverage**
   - each detection metric is shown twice: **gaze only**, and **incl. face lost**, which counts "camera
     working but no face found" as looking away. Turning away from the screen often loses the face entirely.
     Whether the product treats that as looking away is a team decision.
   - **drift diagnostics** per step: median estimate position in the video, head movement since calibration, and
     distance change. If on-video steps drift from the centre as head movement grows, drift is the cause.
   Each step counts equally within its class. `uncertain` and unavailable frames count as not detected, which is conservative.
5. **Shrink video** tests geometry changes. Calibration lives in screen coordinates, so resizing or moving
   the video should not require recalibrating.
6. **Record → Download JSONL** exports fixture messages (no images) for Person 3 (inference) and Person 5 (integration).
   Accuracy-test results are included in the recording.

## Using it in the player

```ts
import { GazeEngine } from "@oxford-hack/gaze";

const engine = new GazeEngine({ sessionId, getVideoElement: () => playerVideoEl });
engine.on("observation", (o) => send(o));   // ~15 Hz GazeObservation
engine.on("summary", (s) => send(s));       // 1 Hz GazeSummary
await engine.start();
await engine.calibrate({ show: (p) => drawTarget(p), hide: () => clearTarget() });
```

Message contracts: `src/types.ts`, with a JSON Schema draft in `schema/gaze_observation.v0.schema.json`.
These are a **proposal for Person 5** to fold into the shared contracts.

## How it works

| Stage | Method |
|---|---|
| Face model | MediaPipe Face Landmarker (`@mediapipe/tasks-vision`, Apache-2.0): 478 landmarks incl. irises, blendshapes, head transform. GPU delegate with CPU fallback. |
| Features | Head yaw/pitch/roll from the transform; iris position within each eye opening; eye openness from blink blendshapes; face position/scale for staleness. |
| Calibration | Ridge regression to screen px. Dots: `[yaw, pitch, iris_x, iris_y]` on per-dot medians. Moving dot: adds face position and scale, fitted on all frames with a searched eye lag. Held-out error is averaged per dot or block, so correlated frames can't inflate confidence. Quality is judged from held-out error vs. video size: `fine` ≤ 20% of the short side, `coarse` ≤ 60%, else `unusable`. |
| Accuracy test | Scripted on/off-video steps scored per step: look-away detection rate, false-alarm rate, balanced accuracy, coverage (`src/validation.ts`). |
| Smoothing | Rolling median of the screen estimate over 700 ms (`smoothingMs`), restarted after gaps, so single-frame spikes don't flip the region. Adds roughly 0.35 s of lag. |
| Region | Signed distance to the video rect with a band of ±max(40 px, 1.5 × held-out RMS) → `on_video` / `uncertain` / `off_video`. A coarse calibration yields mostly `uncertain`, by design. |
| Staleness | If the head moves >12% of the frame or changes distance >25% for >1.5 s, mapping pauses (`CALIBRATION_STALE`). After 10 s it expires and needs recalibration. Distance comes from the face model's 3D depth, not the eye gap in the image, because the eye gap shrinks when you turn your head and was wrongly flagging head turns as stale. |
| Unavailability | Explicit reason codes; a 1 Hz heartbeat when no frame is processed, so silence never means "fine". Missing values are `null`, never 0. |

## Known limitations

- Laptop webcams give **coarse** gaze. Expect held-out errors of roughly 100-250 px, so the meaningful signal is
  "facing the video vs. clearly looking away", not where on the slide someone is looking.
- Glasses glare, backlighting and low light degrade iris tracking. Test in the demo room.
- If head and eyes move in lockstep during calibration, the fit can't separate them. Move your eyes naturally.
- Looking down at notes reads as `off_video`. Interpreting that is Person 3's job (combined with EEG), not this module's.
- Viewport-to-screen conversion approximates browser toolbar height; docked devtools can offset it.
- Not yet tested on the actual demo laptop or in venue lighting.
