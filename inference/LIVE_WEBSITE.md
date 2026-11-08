# The player website and live sensors

The main ReMind application is `frontend/src/product/App.tsx`, mounted at `/`.
It embeds the existing lecture player, transcript, attention timeline and review controls.
Aryan's `/src/player/dev/index.html` remains a standalone development harness.

Start the main product and physical EEG backend from the repository root:

```powershell
npm run dev:live-eeg
```

The launcher waits for both services and opens the paired browser automatically. Pass
`-- --no-open` to open the printed pairing URL manually. Custom ports remain available through
`-- --frontend-port 5173 --backend-port 8766`.

All prerequisites, connection/device status, local profiles and calibration controls are behind
**Session setup** in the header. Open a lecture, calibrate there, and return to watching; closing
setup preserves the player, camera and calibration task. A compatible saved personal baseline is
automatically loaded on future lectures. Saved camera settings require a short current-camera
validation before reuse. See [SESSION_SETUP.md](SESSION_SETUP.md) for persistence and installation.

Physical EEG requires an implemented model factory, the g.tec UnicornPy SDK and a connected
headset with confirmed channels/units. The physical source retries missing/disconnected hardware.
Missing model/SDK/headset remains unavailable. No mock, scripted score or EEGMAT fallback is
selected. The old session-spectral-similarity path is not the default model.

The actual classifier/feature boundary and experimental personal-threshold behavior are described
in [REMIND.md](REMIND.md). Annie's classifier implementation is not currently included. Webcam
processing stays in the browser, with calibrated measurements sent through the existing session.
After gaze opt-in, gaze corroborates model-based reminders rather than replacing model output.
Playback/replay safety, evidence mapping and cooldown remain in the backend.

Live review bypasses `/evaluation-api`. Calibration and observations use the existing ReviewClient
and clock-mapping hub. Review suggestions arrive as normal backend-mapped bookmarks and replay
through the existing player interface. Nothing pauses or rewinds automatically.

Automated checks use explicit source/camera fixtures. They verify transport and UI behavior, not
physical headset performance or attention accuracy. Real hardware/model validation remains pending.
