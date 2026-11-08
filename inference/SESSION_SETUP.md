# Session setup and remembered calibration

Start the physical application from the repository root:

```powershell
npm run dev:live-eeg
```

The launcher starts Python and Vite, waits for both health checks, and opens the paired browser.
Use `-- --no-open` to keep browser opening manual. Missing model configuration opens Session setup;
otherwise the lecture view stays clear. Connection starts automatically and the physical source
retries a missing/disconnected headset every three seconds without a mock fallback.

## One-time installation

Use Python 3.11–3.13 with the platform dependencies, `eeg/requirements.txt`, and the vendor UnicornPy
SDK installed in the same environment. `EEG_PYTHON` selects that Python. Install frontend dependencies
and the existing gaze model/WASM assets as documented in `evaluation/player/README.md`.

Annie must supply the actual model implementation described in `inference/REMIND.md`. An installer
can configure it once with `node inference/live_dev.mjs --model-factory actual.module:factory`.
This writes `.local/eeg-launch.json` (ignored by Git). Later launches reuse it. A CLI argument or
`REMIND_MODEL_FACTORY` environment variable overrides the stored factory. The factory shown here is
a placeholder, not a model bundled in this repository. No dataset uploads are needed for live runs.

## Website

Open **Session setup** in the header for connection status, prerequisites, profile selection,
personal EEG calibration and camera calibration. None of these controls appears in the lecture
sidebar. The setup dialog stays mounted when closed, so it does not recreate the player, stop the
camera, end the session or interrupt EEG calibration. Keyboard Escape returns to the lecture;
an active gaze-dot sequence must finish or be cancelled first.

Open a lecture, choose a local profile, calibrate the camera if wanted, and start personal EEG
calibration. Return to the lecture and watch attentively for twenty seconds of usable model output.
Future sessions automatically select the remembered profile and load a compatible baseline.
Changing profile, model configuration, feature schema, channels or expected window sample count
requires matching calibration. Expired/corrupt profiles stay unavailable until recalibrated.

EEG summaries live under the repository's absolute `.local/calibration/` path, independent of the
launch directory, or under `REMIND_CALIBRATION_DIR` when explicitly configured. The summaries retain
up to five successful calibrations and expire after ninety days. They contain summary statistics,
not raw EEG. The browser remembers the profile name in `remind.participant`.

Successful camera calibration saves versioned coefficients and camera settings locally, separately
for each profile. **Use saved camera setup** requests the camera and checks three targets against
fresh measurements. Restored gaze stays invalid throughout that check; only success announces a
fresh current-session calibration ID/status and allows valid observations. A changed camera,
expired/corrupt data, poor check, cancellation or camera loss requires calibration again. Reset is
available inside setup. Camera frames and raw landmarks are never persisted by this workflow.

## Validation

`frontend/e2e/setup.config.ts` verifies the uncluttered default view, dialog access/focus, preserved
player identity, mobile overflow, and automatic profile loading across reloads. New camera-memory
unit tests cover per-profile storage, corruption/expiry, blocked storage, validation gating,
camera mismatch and cancellation. Backend tests cover calibration reuse across lectures and launch
directories, configuration changes, expiration and physical-source reconnection attempts.

The repository currently lacks Annie's implemented factory and a verified physical SDK/headset
configuration. Software tests use declared fixtures; they do not establish hardware/model accuracy.
