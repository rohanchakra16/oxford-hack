# Player evaluation results — 7 November 2026

Follow-up #38 adds calibrated EEG + gaze fusion, timestamp flags and end review.
Final local backend suite: **252 passed**. Existing frontend unit tests:
**104 passed**. New elapsed-time gaze-window tests: **5 passed**. Real-player
evaluation browser suite: **5 passed**, covering the original dip/replay path,
end-of-lecture review, combined threshold crossing, camera-loss unknown state,
saved replay during evaluator failure, no camera request on load and cancellable
calibration without pausing playback. Evaluation/UI and gaze-adapter TypeScript,
ESLint, Ruff and the production evaluation build passed.
The unchanged product/infrastructure browser regression suite also passed
**all 22 tests** after rebasing onto the eight-second preset.

The combined browser test supplies explicitly synthetic calibrated gaze windows
to the real Python fusion model while playing an actual 40-second video. It
learns the focused baseline, saves one range after a sustained combined loss,
and keeps playback running. Camera loss suppresses detection while the saved
flag remains replayable. Unit/API tests exercise the exact 30-second monotonic
cooldown boundary, seek bypass prevention, suppressed flags remaining suppressed,
range updates, end/replay retention, calibration replacement and invalid inputs.

The user-requested **8 s dwell from #41 is preserved**. It is separate from the
8 s focused baseline and 30 s bookmark cooldown. Default fusion uses 60% EEG
loss + 40% calibrated look-away with a 0.70 trigger before EMA/dwell. Original
EEG-only evaluation is available at `/?signals=eeg`. The default combined
script reserves 0–14 s for the baseline before its low EEG interval at 14–36 s.

No hardware EEG, webcam accuracy or human attention accuracy was measured in
these fixtures. The existing EEG source remains scripted or optional offline
workload scores; the actual camera path reuses Shinju's public module and held-out
dot calibration. Camera frames stay local. Aryan approved the end summary on the
board; all jumps use the existing `replayRange`, with no player, gaze source,
product, shared schema or transport edits.

Follow-up #40 changes the current sustained-low requirement from 10 s to 8 s.
The original verification below used 10 s. The follow-up passed 35 targeted
lecture/API tests and TypeScript checks, including the exact eight-second
boundary and preservation of two separate review moments. Replay summaries
were regenerated with 8 s; the scripted comparison remains 3 triggers to 1.
Smoothing still applies before the sustained-low clock starts. Saved moments
accumulate, while the UI displays a single latest heads-up rather than stacked
banners.

Issue #35. Tested locally on Windows, Python 3.13.18, Node 24.22.1 and
Playwright 1.65.0 / Chromium 158. Commands and launch instructions are in
[README.md](README.md).

| Check | Result |
| --- | --- |
| Inference + evaluation + platform Python suite | 236 passed (including newly merged realtime checks) |
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

Final verification included the realtime tests merged during this work. Their
combined run exposed test-package leakage: the optional public-EEG tests left
the pinned `eeg` snapshot in Python's module cache, preventing later realtime
tests from finding the current classifier. The snapshot fixture now restores
the prior `eeg.*` modules after each compatibility test; production EEG code
and model preprocessing are unchanged.

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
