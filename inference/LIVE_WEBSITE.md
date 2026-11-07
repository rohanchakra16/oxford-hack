# The actual player website and live sensors

The main Recallroom website is `frontend/src/product/App.tsx`, mounted at `/`.
It embeds Aryan's real `frontend/src/player/LecturePlayer.tsx` and transcript.
Aryan's standalone development page is `/src/player/dev/index.html`; its own
HTML explicitly describes it as a development harness, not the product website.
There is no separate deployed Aryan website configured in this repository.

Run the real product and physical EEG source from the repository root:

```powershell
node inference/live_dev.mjs --frontend-port 5173 --backend-port 8766
```

Open the **pairing URL printed by the backend** (`http://127.0.0.1:5173/#pair=…`).
Do not add `?adapter=synthetic` for live sensors. Select a lecture and click
**Calibrate EEG + gaze** to allow the camera and follow its calibration dots.
Play normally for the focused EEG baseline. Camera processing stays in the
browser; only calibrated measurements are sent over the existing live session.

The physical source requires the g.tec Unicorn SDK (`UnicornPy` importable),
a connected headset with confirmed EEG channels/units and the existing Python
EEG/scientific dependencies. `EEG_PYTHON` selects that Python environment.
Missing SDK/hardware shows EEG unavailable; the launcher never selects a mock,
scripted source or EEGMAT fallback. Install the existing gaze assets before
camera use as documented in `evaluation/player/README.md`.

Live `useFocusReview` bypasses `/evaluation-api` completely. Calibration and
batched observations go through ReviewClient and the shared clock-mapping hub.
The backend reuses the existing EEG quality/clock gates and mapped gaze coverage
validator. After explicit camera calibration, combined score is
`0.6 * EEG baseline/model score + 0.4 * on-video fraction * 100`; a score <=30
is the existing 0.70 loss gate, followed by 5 s smoothing, 8 s dwell and >=30 s
cooldown. The personal spectral baseline is learned only from usable EEG with
usable on-video gaze once combined mode is selected. Missing or expired gaze
resets pending loss instead of reverting to EEG-only reminders.

Without camera opt-in the existing EEG-only path remains available. EEG-only
sessions retain their original detector identity and policy. Combined reminders
carry both contributing signals and arrive as normal backend-mapped bookmarks;
the UI keeps those bookmarks visible and uses the existing replay interface.
Stopping the camera sends calibration expiration. Playback/replay gates and
the thirty-second cooldown remain shared with the existing live EEG adapter.

This is experimental detection of EEG/gaze changes, not validated attention
accuracy. The current physical model is session-calibrated spectral similarity.
`evaluated_modes` stays empty; automatic live modes require explicit operator
opt-in through the live launcher.

Validation: 274 backend tests, 104 existing frontend unit tests plus three live
gaze-contract tests, typecheck/lint/build and
a main-site test with controlled source/camera fixtures. That browser test
verifies live calibration/observation transport, a combined mapped bookmark,
manual replay and zero evaluation-endpoint calls. It does not establish real
headset performance. This development machine has no importable Unicorn SDK;
physical collection remains unavailable until the SDK/headset is supplied.
