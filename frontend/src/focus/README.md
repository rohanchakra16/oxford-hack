# Main frontend focus bookmarks

Issue #44 mounts the existing #43 EEG/gaze implementation in the normal product
page. No detector, camera calibration or player logic is copied. The product
hook reuses `evaluation/player/{client,gaze,GazeCalibration}` and the same
Python fusion/cooldown service; accepted ranges use the existing bookmark cards,
transcript sentence replay, timestamp flags and end-of-lecture review.

Run `npm run dev:focus` from the repository root, then open
`http://127.0.0.1:5173/?adapter=synthetic`. This starts the main frontend and
the existing loopback evaluator. Install frontend dependencies and gaze assets
as described in `evaluation/player/README.md`. The pinned camera runtime is
also a frontend dependency so normal frontend builds resolve it.

Select a local video, click **Calibrate EEG + gaze**, follow the dots, then
play and watch normally for the eight-second baseline. This explicit action
enables combined tracking. Until then, ordinary product sessions work as before.
Combined mode displays its cooldown-filtered ranges in place of legacy automatic
examples; manual markers stay available. Local focus IDs are presentation data
and are never sent through the shared bookmark/feedback transport. Dismiss is
local, matching the product's existing behavior.

Current EEG inputs are scripted or optional offline workload scores, visibly
labelled in the UI. This does not enable live-headset inference. The existing
0.70 threshold, eight-second sustained-loss check and 30-second cooldown are
unchanged. Camera loss and evaluator errors leave playback/manual markers usable.

Alternative ports: set `EVALUATION_PLAYER_PORT` and `EVALUATION_API_URL` before
launch. `EVALUATION_PYTHON` selects the interpreter as in the original launcher.

Validation: `evaluation/player/main-product.spec.ts` exercises this actual product
entry point with a calibrated webcam fixture and the real Python evaluator/player,
including manual-marker coexistence, one focus flag, end review and bounded replay.
