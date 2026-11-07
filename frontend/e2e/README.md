# Infrastructure e2e tests (Person 5)

Real Vite frontend + real FastAPI backend + real WebSocket, Chromium only, on loopback ports
15173 (frontend) and 18765 (backend). The backend runs with `--enable-test-hooks` and a throwaway launch
token under `frontend/test-results/` (git-ignored). Nothing here uses real EEG, webcam or participant data.

```bash
cd platform && uv sync              # once
cd ../frontend
npx playwright install chromium     # once
npm run e2e                         # headless
npm run e2e:ui                      # UI mode
npm run e2e:headed
npm run e2e:report                  # open the last HTML report
```

Playwright starts both servers itself (`uv` must be on PATH). Traces and screenshots are kept for failures only.
CI retries once; local runs never retry. The CI job uploads the report, traces and screenshots on failure (3 days).

## Diagnostics tests (`connection`, `pipeline`, `robustness`)

Drive `/diagnostics` with a *synthetic virtual media clock*: pairing, connection and clock sync, session start,
backend-injected candidates becoming mapped bookmarks, duplicate/too-old/runKind/pause-boundary rejections,
malformed messages, reconnect and resume, and "sensor unavailable" staying distinct from a lapse or a zero.

## Player tests (`player.spec.ts`)

Drive Person 4's player dev harness (`/src/player/dev/index.html`) with a real `<video>`: a synthetic 40 s WebM is built
at test time with Playwright's bundled ffmpeg into `test-results/` (flat colour, no people, never committed).
Covered: play/pause/seek against the real backend's telemetry segments, `replayRange` stop point, rejection of a
non-video file, and replay of a suggestion. The suggestion comes from the explicitly **synthetic** adapter, because the
player starts `live` sessions and no sensors are attached here.

## Product tests (`product.spec.ts`)

Drive the composed product UI (Betty's design on the shared `LecturePlayer`/`TranscriptPanel`/`ReviewClient`) with a real
`<video>` and a generated WebVTT. Synthetic adapter (clearly labelled) for suggestions: transcript follows playback and
seeks, Replay starts at the containing sentence and stops at its end, Move earlier steps back one sentence, Dismiss, and the
no-transcript fallback. Live adapter: exactly one session and one telemetry path reach the real backend.

## Not covered

Obsolete session/video/segment events are covered at the hub level (`platform/tests/test_hub.py`). Real sensors and
backend-mapped bookmarks in the product UI (no EEG/gaze source is attached in these tests).
