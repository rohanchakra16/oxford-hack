# Integration guide (Person 5)

Who plugs in where. Authoritative message shapes are in `contracts/` (see `contracts/README.md`).

```
EEG source (P1) --EegSink--> hub <--InferenceAdapter-- detector (P3)
webcam gaze (P2, browser) ---------> hub (via ReviewClient)
player (P4) --attachMediaElement--> ReviewClient --WebSocket--> hub --bookmarks--> review UI (P4)
```

- **EEG (P1)** implements `oxford_hack.eeg.interface.EegSource` and pushes `eeg_features` / `eeg_status` to an `EegSink`.
  Device time is mapped to backend ms with `timing/device_clock.py`. Start the backend with
  `oxford-backend serve --eeg-source package.module:factory`: the repository root is on the import path, the factory is
  called with no arguments and must return an `EegSource`, which runs on its own thread and publishes into a bounded
  sink. The hub drains the sink every tick into **live** sessions that enabled EEG (never into simulated or replay
  ones). A bad spec exits with code 2; a source that never reports leaves EEG "unavailable". Status or features published
  while no live session exists are dropped, so sources should publish periodically, not once.
  Annie's pipeline (`eeg/realtime/streaming_controller.py`) emits frames, not `EegFeatureWindow`s: a mapper to the
  contract (feature names/units, quality flags, clock correction) is still to be agreed and written.
- **Gaze (P2)** emits `gaze_calibration` and `gaze_observations` (0.1.0) through the frontend `ReviewClient`. The adapter
  must be given the `<video>` element (or a getter returning it).
- **Inference (P3)** implements `oxford_hack.inference.interface.InferenceAdapter`: it receives windows, gaze, eligibility
  and sensor status in backend ms and returns `ReviewCandidate`s. It never touches media time. For simulated sessions run
  `oxford-backend serve --simulated-detector baseline`.
- **Player (P4)** mounts `LecturePlayer`, which forwards telemetry with `attachMediaElement`. Mount exactly one telemetry
  path per video. Review UI uses `ReviewClient` only: no `WebSocket` in product code (ESLint enforces it).
- **Everything** speaks `schemaVersion` `0.1.0` exactly; a change bumps it and regenerates schema, fixtures and TS types
  (`npm run contracts:generate`; CI fails on drift).

Run it all: `npm run setup` once, then `npm run dev` (backend on 8765, frontend on 5173). Open the pairing link printed by
the backend. Diagnostics: `/diagnostics`. Tests: `cd platform && uv run pytest`, `cd frontend && npm test && npm run e2e`.
