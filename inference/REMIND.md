# ReMind integration (#62)

The main application (`frontend/src/product/App.tsx`) now mounts Aryan's existing attention graph,
summary, and player information popover. It uses the existing player, ReviewClient, timeline store,
bookmarks, replay planning and gaze calibration. Original ownership/credit comments are retained.
The M/W wordmark is a small SVG; the visible and accessible product name is ReMind.

## Actual model boundary

The repository currently provides Annie's acquisition, preprocessing, feature registry, streaming
controller and classifier interface, **not an implemented attention model**. The six default
registry functions return invalid `Not implemented`; `StubAttentionClassifier` is a development
mapper, not a trained classifier. No Unicorn Black Hybrid attention accuracy/results file is present.
Consequently the physical main-page path now remains unavailable until a real pipeline is supplied;
it no longer silently uses the prior spectral-similarity heuristic.

Annie can expose `module:factory` returning `inference.model_source.ModelPipeline` with her populated
`registry`, implemented `classifier`, `model_id`, `version`, finite `score_min`/`score_max`, explicit
`higher_is_attentive` and optional `minimum_confidence` (default .6). Set `REMIND_MODEL_FACTORY` to
that factory, then launch `node inference/live_dev.mjs --backend-port 8766` and open its pairing link.
The vendor UnicornPy SDK and headset must also be available. No stub or invented model is accepted.

The adapter executes her registry through `EEGFeatureExtractor` and passes the complete resulting
feature frame to her classifier. The classifier must return `valid: true`, `attention_score` in its
declared native range, and optionally a finite confidence in [0,1]. Scores are linearly normalized
using only the declared bounds and direction; this is a model scale, not a probability of attention.
Raw model scores, confidence and scalar registry values are retained as distinct named features.
Structured registry values are passed unchanged to the classifier; the existing wire format carries
only scalar features. Registry units are marked model-native, not guessed. Model exceptions,
unsupported outputs, low confidence, bad contact/basic artifact diagnostics, stale windows and
clock/coverage failures cannot create attention bookmarks. The preprocessing quality checks are
basic checks, not validated artifact removal.

Model version/configuration changes must increment the supplied model version. The calibration
signature additionally includes declared normalization, confidence settings, registered feature
configuration, output geometry, producer identity and channel names. A new stream resets temporal
evidence. No four-class interpretation is invented; the UI shows low/very-low model estimates and
within-baseline scores, plus unavailable/calibrating states.

## Calibration and stable detection

The viewer selects a local participant name (default `local`) and watches attentively while a
20-second task collects at least 30 usable model outputs. Missing quality/gaze coverage or a >2 s
gap restarts incomplete evidence. A baseline with SD >20 points or P90−P10 >50 is rejected.
Summaries contain mean, population SD, P10/P90, count and timestamp. No EEG samples are persisted.

Let `s = max(SD,5)`. The initial low entry boundary is
`clamp(min(mean−2s, P10−s), 5, 80)`. Recovery is `min(95, low+max(5,.75s))`;
very-low is `max(0, low−s)` with its own recovery margin. These are tunable experimental settings,
not clinically established attention boundaries. Baselines are stored atomically under
`.local/calibration/` (or `REMIND_CALIBRATION_DIR`) keyed by participant and configuration.
The last five successful calibrations are retained; compatible profiles up to 90 days old reload
across lectures/backend restarts. Failed/cancelled recalibration preserves the previous good profile.
Reset removes the current participant/configuration history. No account system is needed.

The primary model score is smoothed with a 2.5-second EMA. Enter a pending episode below the personal
low boundary. Values between low and recovery retain the episode; values above recovery suppress
emission, and four seconds of recovery clears/rearms it. Eight seconds elapsed in an unrecovered
episode emits at most one bookmark. Reminders are at least 30 seconds apart, including across
recalibration. Replay, pause, invalid timing/quality and unavailable input interrupt pending evidence.
After camera opt-in, continuous calibrated gaze is mandatory and >=50% look-away over the event
must corroborate the low model estimate. Gaze never changes the meaning/scale of the model score.
Gaze alone cannot create a model reminder. EEG-only operation remains explicit before camera opt-in.

## UI and transport

The authenticated `GET /api/v0/attention/{session}` and
`POST /api/v0/attention/{session}/calibration` endpoints require an allowed Origin and launch token.
They reuse the current session and backend. Score intervals use the same strict backend-to-media
mapping as bookmarks. The frontend polls at 500 ms, refreshes the compact curve at 1 s and preserves
its derived timeline/markers in the existing localStorage store. The legacy storage key is retained
to keep previous lecture summaries usable. Live graph and summary share one store. Orange review
dots use the nearest trace value (or their recorded score); missing values never become zeros.
Click/keyboard activation seeks to the bookmark/low region start, with transcript-aware replay for
current-session bookmarks. The active dot is highlighted. No automatic rewind or pause is added.

`?adapter=synthetic` exposes the existing labelled UI demo, whose values stay simulated and are
excluded from real statistics. The scripted live rehearsal remains separately labelled and retains
its legacy policy. Neither demonstrates physical model accuracy.

## Verification

`inference/tests/test_personalized.py` covers successful/reused/incompatible/cancelled calibration,
unstable rejection, persistent reset, hysteresis, eight-second episodes, recovery/cooldown, poor
quality suppression, actual registry-to-classifier values and stub rejection. Transport tests cover
token/origin enforcement. `frontend/e2e/live/remind.spec.ts` exercises the actual main page,
orange-dot activation/seeking, summary completion and restoring saved markers after reload.
Existing backend/frontend and EEG/gaze browser regressions remain required.

Physical headset collection and model accuracy cannot be verified until Annie supplies the
implemented factory, score definitions and evaluation results, and the vendor SDK is installed.
