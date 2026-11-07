# Lecture player evaluation

Issues #35 and #38. Owner @Seikaro. Reuses @aryanmorarji's actual `LecturePlayer` and
public `PlayerHandle` without changing player, product or shared transport code.

The evaluation view connects player progress to the existing **Python**
`LecturePrototype`, combines the existing EEG input with calibrated webcam gaze,
and displays a quiet heads-up once per saved bookmark. Timestamp flags beside
the player and the end-of-lecture summary support one-click Replay. Detection never pauses
or seeks the video. Replay is an explicit `player.replayRange` request;
`getState().replay !== null` suppresses evaluation throughout that replay.

This is a runnable evaluation view at port 15174, separate from the product
home page. It does not enable the learned workload proxy as a live attention
detector. Shared WebSocket adoption still belongs to the platform/UI owners.

## Run

Install frontend dependencies (`npm --prefix frontend ci`), the gaze runtime
(`npm --prefix gaze ci --omit=dev`), and local model assets
(`npm --prefix gaze run setup`). These use the gaze owner's existing lockfile
and asset setup without modifying gaze source. Use a
Python environment with the platform dependencies (FastAPI, uvicorn, Pydantic)
and the repository on PYTHONPATH. The launcher sets PYTHONPATH for both services
and chooses `platform/.venv`, then `inference/.venv`, or `python` on PATH.
Set `EVALUATION_PYTHON` to choose an explicit interpreter.

```powershell
$env:EVALUATION_PYTHON = "$PWD/inference/.venv/Scripts/python.exe"
node evaluation/player/dev.mjs
```

Open http://127.0.0.1:15174 and select a local video at least 40 seconds long.
Only playback metadata and derived gaze-window scalars reach the loopback
evaluator on port 18766. Video, webcam frames, landmarks and filenames stay in
the browser; the server receives the existing hashed video ID.
Closing the launcher stops both services. `npm --prefix evaluation/player run dev`
is equivalent. Both ports must be free.

The default view uses **EEG + gaze**. Open a lecture, leave it paused while you
click **Calibrate EEG + gaze**, and follow the dots. Then play and watch the
video normally for eight seconds to learn a focused baseline. No camera prompt
appears until you click calibration; Stop camera or Escape during calibration
releases the camera. Stopping, losing, or denying the camera suppresses combined
flags while video playback remains available.

The combined script has a focused interval before a low EEG interval at 14–36 s;
look-away must coincide with low EEG for a combined flag. The script and browser
fixtures are tests, not live attention measurements. Dot calibration uses the
gaze owner's held-out check. A new calibration ID starts a new focused baseline.

Open `http://127.0.0.1:15174/?signals=eeg` for the original EEG-only evaluation.
That built-in smoke sequence ignores a dip at 3–5 seconds and marks a
sustained low interval at 10–36 seconds. Because smoothing and persistence apply,
the saved range begins at the first qualifying **smoothed** low window, not at
the raw scripted change. The heads-up appears about eight seconds after that
window; the bookmark retains its earlier media start. Playback pauses, seeks,
buffering, gaps, replay and missing scores reset pending detection. The view
shows an unavailable state and a reconnect button if evaluation fails.

## Conservative settings

Default for this integration: `inference/bundles/lecture-conservative-0.1.0.json`.

| Parameter | Earlier prototype | Player evaluation |
| --- | ---: | ---: |
| Low-score trigger maximum | 0.40 | 0.30 |
| Smoothing time constant | 2 s | 5 s |
| Sustained-low dwell | 4 s | 8 s |
| Recovery threshold / dwell | 0.50 / 2 s | 0.45 / 4 s |
| Merge gap | 5 s | 10 s |
| Question cooldown, if used outside this normal-mode view | 30 s | 60 s |

Scores are prototype inputs, not attention percentages. These settings trade
slower detection and missed short losses for fewer nuisance triggers. The
normal-mode heads-up is emitted once per saved bookmark; range extensions do not
repeat it. Closing it or dismissing a card does not reset the cooldown.
Saved review moments accumulate across separate episodes. One heads-up is visible
at a time; a new segment replaces the current heads-up rather than stacking banners.
Nearby episodes can merge under the ten-second merge rule. The eight-second
requirement applies after smoothing crosses the low threshold, using advancing
evidence timestamps; smoothing and the sampling cadence can add detection delay.

## Combining EEG and gaze

`inference/lecture_fusion.py` learns an elapsed-time-weighted EEG and gaze baseline
from eight continuous seconds of usable playback, EEG score >= 0.5 and calibrated
look-away fraction <= 0.2. Missing evidence or a playback interruption resets an
incomplete baseline. Baseline samples never also count as loss evidence.

After calibration, the prototype uses:

```text
EEG loss  = clamp((baseline EEG - current EEG) / max(0.25, baseline EEG), 0, 1)
gaze loss = clamp((look-away - baseline look-away) / max(0.5, 1 - baseline look-away), 0, 1)
combined loss = 0.60 * EEG loss + 0.40 * gaze loss
```

Default trigger: combined loss >= 0.70, followed by the existing 5 s EMA and
8 s sustained-low requirement. Neither source alone can reach 0.70. Recovery
retains the existing hysteresis. The threshold comes from `1 - low_attention_max`
in the selected lecture profile. These weights and thresholds are prototype
settings, not calibrated probabilities or validated lecture-attention accuracy.

Gaze windows are weighted by elapsed time, require >=80% valid coverage, and
reject >250 ms frame gaps/staleness, hidden tabs, uncertain gaze, missing eyes,
invalid calibration and calibration-ID changes. Gaze measurement confidence is
never treated as an attention score. The gaze package retains its own compiler
settings through a small checked adapter; the evaluation UI keeps its existing
strict TypeScript settings.

## Bookmark cooldown and end review

New bookmarks require **30 seconds of backend monotonic time** since the previous
saved bookmark. Playback speed, seek, dismiss and replay cannot bypass it.
Suppressed flags remain in `segments` for evaluation and never turn into delayed
pings. `bookmarks` contains accepted IDs with their latest ranges, so extensions
update the original flag instead of creating another. New lectures start fresh.

The existing player reports `ended`; the same saved timestamps remain available
under **End-of-lecture bookmarks**, including while explicitly replaying them.
Positive-length replay guards follow Aryan's review. Temporary evaluator errors
retain saved flags, which still replay locally. Explicit reconnect starts a new
evaluation session. No disk persistence or shared transport adoption is added.

## Optional offline EEGMAT-derived scores

Prepare a workload JSON with `inference.workload_cli` as described in
`evaluation/EEGMAT.md`. Then:

```powershell
node evaluation/player/dev.mjs --workload-json inference/.local/player-eegmat-workload.json
```

Scores are mapped onto an explicitly hypothetical timeline starting at zero;
outside its coverage, estimates are unknown. Windows that cross score boundaries
use duration-weighted scores only when the entire interval is usable and covered.
No raw EDF upload is supported. EEGMAT classifies arithmetic versus rest and has
no lecture-attention truth; a real-data run may correctly produce zero review
events. Use the scripted smoke sequence to verify a known alert path.

## Tests and review artifacts

```powershell
$env:PYTHONPATH = "$PWD;$PWD/platform/src"
inference/.venv/Scripts/python.exe -m pytest inference/tests evaluation/tests platform/tests
node frontend/node_modules/typescript/bin/tsc -p evaluation/player/tsconfig.json
node frontend/node_modules/typescript/bin/tsc -p evaluation/player/tsconfig.gaze.json
npm --prefix evaluation/player test
node frontend/node_modules/typescript/bin/tsc -b frontend
# Install Playwright's browser once:
node frontend/node_modules/@playwright/test/cli.js install chromium
npm --prefix evaluation/player run smoke
npm --prefix evaluation/player run test:infra
inference/.venv/Scripts/python.exe -m evaluation.player_smoke --workload-json inference/.local/player-eegmat-workload.json
```

Smoke: real video, brief-dip suppression, one heads-up, original media timestamp,
noninterruptive playback, bounded replay, no duplicates, dismissal, and service
failure, calibrated combined threshold crossing and end review. Camera accuracy
is not inferred from synthetic browser fixtures. Unit/API tests also cover
the exact 30 s cooldown boundary, seek bypass prevention, suppression without
delayed pings, full-window gaze quality and calibration resets. `test:infra` runs all existing
22 browser tests through their unchanged source files, using an explicit Python
interpreter instead of requiring `uv`/`npx` on PATH.

HTML reports: `frontend/playwright-report/evaluation/index.html` and
`frontend/playwright-report/infra/index.html`. Smoke traces and screenshots:
`frontend/test-results/evaluation/`. These are ignored local artifacts.
Committed summaries: `evaluation/fixtures/player-smoke-report.json` and
`evaluation/player/RESULTS.md`.

## Integration contract for Aryan / Betty / Rohan

`observeEvaluation(player, videoId, durationS, update, error, options)` returns a cleanup
function. It observes the public player state, sends ordered progress requests
every second and immediately on playback-state/rate/replay changes, and closes
its evaluation session on cleanup. Existing `attachMediaElement` stays the sole
player telemetry attachment. Automatic timer-based synthetic bookmarks are
disabled in this evaluation harness.

Options are `{combineGaze, readGaze}`; defaults preserve EEG-only API callers.
`POST /sessions {videoId,durationS,combineGaze?}` creates an isolated session.
`POST /sessions/{id}/tick {seq,mediaS,state,playbackRate,replaying,gaze?}` returns
`{sessionId,videoId,prototype,source,status,segments,bookmarks,ended,bookmarkCooldownS,fusion,events,config}`.
`gaze` contains `{calibrationId,calibrationValid,validFraction,outsideFraction,windowMs,newestAgeMs,maxGapMs}`;
it is a derived local evaluation window, not a new shared contract message.
`DELETE /sessions/{id}` closes it. Requests use backend receipt monotonic time;
this demo adapter maps observed progress only and does not map live EEG clocks.
Browser ages/windows are checked locally and at the loopback boundary, not
represented as production cross-clock synchronization. Test runs can set
`EVALUATION_API_URL` and `EVALUATION_PLAYER_PORT` to isolate their servers from
a running preview.
Returned events retain `lecture-prototype-0.1.0` semantics and must not be sent
through the strict shared-message parser. Config files may be supplied using
`--config`; this player view supports normal mode heads-ups/bookmarks.
