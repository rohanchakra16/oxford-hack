# Lecture player evaluation

Issue #35. Owner @Seikaro. Reuses @aryanmorarji's actual `LecturePlayer` and
public `PlayerHandle` without changing player, product or shared transport code.

The evaluation view connects player progress to the existing **Python**
`LecturePrototype`, displays a quiet heads-up once per review segment, and
keeps timestamped review ranges with Replay and Dismiss. Detection never pauses
or seeks the video. Replay is an explicit `player.replayRange` request;
`getState().replay !== null` suppresses evaluation throughout that replay.

This is a runnable evaluation view at port 15174, separate from the product
home page. It does not enable the learned workload proxy as a live attention
detector. Shared WebSocket adoption still belongs to the platform/UI owners.

## Run

Install frontend dependencies normally (`npm --prefix frontend ci`). Use a
Python environment with the platform dependencies (FastAPI, uvicorn, Pydantic)
and the repository on PYTHONPATH. The launcher sets PYTHONPATH for both services
and chooses `platform/.venv`, then `inference/.venv`, or `python` on PATH.
Set `EVALUATION_PYTHON` to choose an explicit interpreter.

```powershell
$env:EVALUATION_PYTHON = "$PWD/inference/.venv/Scripts/python.exe"
node evaluation/player/dev.mjs
```

Open http://127.0.0.1:15174 and select a local video at least 40 seconds long.
Only playback metadata reaches the loopback evaluator on port 18766. Video and
filenames stay in the browser; the server receives the existing hashed video ID.
Closing the launcher stops both services. `npm --prefix evaluation/player run dev`
is equivalent. Both ports must be free.

The built-in scripted smoke sequence ignores a dip at 3–5 seconds and marks a
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
normal-mode heads-up is emitted once per segment; range extensions do not
repeat it. Closing it or dismissing a card does not alter model decisions.
Saved review moments accumulate across separate episodes. One heads-up is visible
at a time; a new segment replaces the current heads-up rather than stacking banners.
Nearby episodes can merge under the ten-second merge rule. The eight-second
requirement applies after smoothing crosses the low threshold, using advancing
evidence timestamps; smoothing and the sampling cadence can add detection delay.

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
node frontend/node_modules/typescript/bin/tsc -b frontend
# Install Playwright's browser once:
node frontend/node_modules/@playwright/test/cli.js install chromium
npm --prefix evaluation/player run smoke
npm --prefix evaluation/player run test:infra
inference/.venv/Scripts/python.exe -m evaluation.player_smoke --workload-json inference/.local/player-eegmat-workload.json
```

Smoke: real video, brief-dip suppression, one heads-up, original media timestamp,
noninterruptive playback, bounded replay, no duplicates, dismissal, and service
failure. The API tests also cover quality, pause boundaries, session isolation,
invalid payloads, and EEGMAT window boundaries. `test:infra` runs all existing
22 browser tests through their unchanged source files, using an explicit Python
interpreter instead of requiring `uv`/`npx` on PATH.

HTML reports: `frontend/playwright-report/evaluation/index.html` and
`frontend/playwright-report/infra/index.html`. Smoke traces and screenshots:
`frontend/test-results/evaluation/`. These are ignored local artifacts.
Committed summaries: `evaluation/fixtures/player-smoke-report.json` and
`evaluation/player/RESULTS.md`.

## Integration contract for Aryan / Betty / Rohan

`observeEvaluation(player, videoId, durationS, update, error)` returns a cleanup
function. It observes the public player state, sends ordered progress requests
every second and immediately on playback-state/rate/replay changes, and closes
its evaluation session on cleanup. Existing `attachMediaElement` stays the sole
player telemetry attachment. Automatic timer-based synthetic bookmarks are
disabled in this evaluation harness.

`POST /sessions {videoId,durationS}` creates an isolated prototype session.
`POST /sessions/{id}/tick {seq,mediaS,state,playbackRate,replaying}` returns
`{sessionId,videoId,prototype,source,status,segments,events,config}`.
`DELETE /sessions/{id}` closes it. Requests use backend receipt monotonic time;
this demo adapter maps observed progress only and does not map live EEG clocks.
Returned events retain `lecture-prototype-0.1.0` semantics and must not be sent
through the strict shared-message parser. Config files may be supplied using
`--config`; this player view supports normal mode heads-ups/bookmarks.
