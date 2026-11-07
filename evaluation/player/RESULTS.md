# Player evaluation results — 7 November 2026

Issue #35. Tested locally on Windows, Python 3.13.18, Node 24.22.1 and
Playwright 1.65.0 / Chromium 158. Commands and launch instructions are in
[README.md](README.md).

| Check | Result |
| --- | --- |
| Inference + evaluation + platform Python suite | 214 passed |
| Existing frontend unit suite | 104 passed across 9 files |
| Existing full browser integration suite | 22 passed |
| New real-video evaluation smoke suite | 2 passed |
| Frontend and evaluation-view TypeScript checks | Passed |
| New evaluation TypeScript ESLint checks | Passed |
| New Python Ruff checks | Passed |

The real player ignored the scripted 3–5 s dip. The sustained 10–36 s dip
generated **one heads-up and one review bookmark**, starting around **0:15**
after smoothing crossed the low threshold. Notification appeared around 0:27,
after the persistence requirement. The saved timestamp stayed at the earlier
low-evidence start while the range extended. Playback continued throughout.
Closing the heads-up did not cause it to reappear on range updates. Explicit
Replay sought to that saved timestamp, stopped at the selected range end and
created no duplicate bookmark. Dismiss worked. An unavailable evaluator showed
an error while local video playback continued.

The deterministic API suite additionally checks pause/reset behavior, replay
suppression, unknown outside workload coverage, crossing four-second workload
window boundaries, duplicate sequence rejection, session cleanup and invalid
payload rejection. The existing inference tests cover buffering, seeking,
staleness, eligibility and scheduling boundaries.

The conservative profile reduced **three scripted triggers to one**, retaining
the long low bout while suppressing shorter/moderate dips. This is a behavior
check, **not a measured false-positive-rate improvement**. The tradeoff is
slower detection and potentially missed short losses.

EEGMAT `Subject00_2.edf` was checksum-verified and scored again through the
existing frozen workload model and pinned Annie preprocessing bridge. Its
first-60-second protocol yielded 12 usable four-second windows after startup.
Both the original and conservative replay produced **zero review segments**.
No data was relabelled or scores altered to manufacture an alert. The optional
EEGMAT timeline is hypothetical; arithmetic/rest labels cannot verify lecture
attention loss or timestamp accuracy. Provenance hashes, aggregate counts and
all profile values are in
[`../fixtures/player-smoke-report.json`](../fixtures/player-smoke-report.json).

Local browser artifacts (ignored by Git):

- `frontend/playwright-report/evaluation/index.html`: smoke HTML report.
- `frontend/playwright-report/infra/index.html`: complete existing browser report.
- `frontend/test-results/evaluation/player-heads-up.png`: visible heads-up and bookmark.
- `frontend/test-results/evaluation/player-smoke.png`: replay/dismiss result.
- `frontend/test-results/evaluation/*/trace.zip`: full smoke traces.

The evaluation harness is a separate view at port 15174 and defaults to the
scripted source. This does not wire live EEG, replace the product homepage or
change the shared WebSocket schema. It reuses the real player's public API;
the platform and product owners can adopt the observer/endpoint contract after
their integration review. The new smoke suite is runnable locally and is not
yet added to the platform-owned CI workflow.
