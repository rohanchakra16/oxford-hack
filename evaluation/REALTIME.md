# Real-time EEG evaluation

This P3 evaluation runner consumes Annie's actual `StreamingController`,
`EEGPreprocessor`, registry and classifier APIs. It performs continuous
processing while acquisition is active, without saving or reloading a recording.
No EEG filters or biomarkers are reimplemented. It changes no shared contracts,
backend wiring, UI, or lecture-prototype code.

## Run without hardware

Install the platform evaluation environment plus numpy/scipy from
`inference/requirements-public-eeg.txt`. From the repository root:

```powershell
$env:PYTHONPATH = "$PWD;$PWD/platform/src"
python -m evaluation.realtime_stream --mock --duration-s 8 --warmup-s 0
python -m evaluation.realtime_stream --mock --duration-s 8 --warmup-s 0 --output data/live-smoke.jsonl
python -m pytest evaluation/tests/test_realtime.py -q
```

The owner's mock device is wall-clock paced. Default analysis uses the last
2 seconds of samples with an update every 500 ms. No future samples are used.
These are soft real-time settings, not measured hardware guarantees. The mock
uses the existing unimplemented biomarkers and stub classifier, so every
attention estimate correctly remains **unknown**. The command still measures
live frame cadence, clock age and pipeline health. `--warmup-s 0` is for this
plumbing smoke run; normal operation defaults to 10 seconds of filter warmup
before the start of a usable evidence window. Baseline calibration is the
supplied feature/model implementation's additional responsibility.

Each update prints JSON immediately. A final report follows at duration expiry
or Ctrl+C. Optional journals are created exclusively (never overwritten) under
ignored `data/` or `.local/` in this checkout. They contain derived features,
predictions and labels and should be treated as participant data; no raw EEG is
persisted. Startup/device failures produce `run_error` and a nonzero CLI exit.

## Connect an owner-provided live pipeline

```powershell
python -m evaluation.realtime_stream --pipeline-factory my_eeg_setup:make_evaluation_session --duration-s 120 --session-id pilot01 --output data/pilot01.jsonl
```

The zero-argument factory returns an **unconnected**
`evaluation.realtime_stream.LiveSession` containing:

- `device`: Annie's EEGDevice implementation, selecting confirmed EEG-only
  channels in microvolts; `eeg_only_confirmed=True` must be explicit.
- `preprocessor`, `feature_extractor`, `classifier`: compatible owner APIs.
  The runner constructs and owns their StreamingController and device lifecycle.
- `source_kind`: `live`, `replay`, or `synthetic`.
- `map_time(device_timestamp_s)`: returns `(host_monotonic_s, uncertainty_s)`,
  or None when mapping is unavailable. Coordinate this with platform's measured
  clock mapping; never align live timestamps to the first packet arrival or
  use the frame's Unix `processing_timestamp`. Uncertainty above 50 ms,
  future/stale windows, and missing mappings produce unknown.
- `model_id` and `model_target`: only explicit `lecture_attention` permits
  experimental attention classification. Workload targets and `model_type=stub`
  always produce unknown. Classifier predictions must have `valid=True`,
  `attention_score` finite in 0..100 and a non-stub model_type. `--threshold`
  (default 50) defines the experimental attentive/inattentive boundary, to be
  tuned on validation labels. Declaring a target does not validate a model.

There is no fabricated default live-device mapping or attention classifier.
This interface is local to evaluation, not the platform EegSource interface.
Real electrode selection, biomarkers and the platform adapter stay with their
owners; the runner can use those components once supplied.

## Quality, stalls and timing

`WindowQuality` decorates the existing preprocessor and retains bounded metadata
spans for all batches intersecting each window. An earlier bad batch therefore
cannot disappear behind a clean latest-batch diagnostic. It rejects missing
coverage, gaps/repeated samples, nonfinite data/timestamps, raw flatlines,
non-microvolt units and the preprocessor's basic quality flags. A discontinuity
resets filtering/warmup. These basic checks do not replace physiological
artifact detection; the owner's features/classifier must also reject artifacts.

No frame after `window_s + stale_s` at startup, or `stale_s` after the latest
advancing frame, emits an unknown status. Duplicate/stale frames cannot keep a
previous score alive. Timing quantiles retain at most 4096 observations;
counts and label confusion are cumulative. Evidence age is measured from the
mapped final sample timestamp, separately from the 2-second evidence horizon.
No score or automatic bookmark is sent to the frontend.
The owner's `streaming_stats.acquisition_overflow` also flags normal rolling
buffer eviction; it does not by itself establish acquisition queue loss.

## Independent labels

Optional `--labels data/pilot01-labels.json` uses this local annotation format:

```json
{"session_id":"pilot01","intervals":[
  {"start_s":12,"end_s":25,"label":"attentive"},
  {"start_s":25,"end_s":30,"label":"unknown"},
  {"start_s":30,"end_s":42,"label":"inattentive"}
]}
```

Times are seconds since runner startup on its host monotonic clock, with end
exclusive. Labels must come from independent self-report/observer protocols,
not model predictions; record retrospective interval uncertainty separately.
Session IDs must match and overlapping labels are rejected. A frame is labelled
only when its **entire evidence interval** lies inside one label interval.
Labels never reach the classifier. These annotations are evaluation-local and
are not the existing backend-ms `evaluation.labels.Label` schema.

Usually independent labels are collected during the session and finalized
afterward. Score the saved predictions afterward without rerunning the model:

```powershell
python -m evaluation.realtime_labels --journal data/pilot01.jsonl --labels data/pilot01-labels.json
```

The journal retains mapped evidence intervals and clock uncertainty for this
purpose. A label must cover the entire interval including its mapping
uncertainty; boundary-crossing windows are left unlabelled. Predictions remain
exactly as recorded, so labels cannot leak into the classifier.

Report frame accuracy, inattention precision/recall on scored frames and
labelled coverage together: unknown windows are reported as abstentions rather
than negatives. Overlapping windows are correlated; these frame metrics do not
establish participant-held-out accuracy, event detection performance or
comprehension. Freeze calibration/thresholds on training/validation sessions
before testing separate participants/sessions, as described in `PROTOCOL.md`.
