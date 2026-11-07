# Calibration and evaluation protocol 0.1.0 (proposed)

Owner: @Seikaro. Sensor semantics are pending confirmation from @annieqqa and
@ShinJuKim; shared timing and integration stay with @rohanchakra16. No real
participant data has been collected or evaluated in this allocation yet.

## Collection and independent labels

1. Obtain participant agreement before recording. Use opaque participant,
   globally unique session, and recording IDs. Keep consent, identity mappings,
   recordings, label JSONL, and dataset manifests in ignored `data/`, outside Git.
   There is no shared participant-data location yet; ask the recording owner
   for authorised access. Do not attach recordings to GitHub issues.
2. Confirm EEG metadata, units, sample rate, channel quality, window definition,
   feature-set version and device-to-backend clock uncertainty with the EEG
   owner. Record a quiet baseline and scripted artifact/gap examples separately
   from attention labels. Do not treat quality flags as behavioural labels.
3. Use gaze-owner calibration and distinct held-out targets; record calibration
   ID, measurement kind, error, viewport/video geometry and invalidations.
   Head direction cannot stand in for screen gaze. Recalibrate following the
   sensor owner's geometry/camera validity rules. Do not upload webcam frames.
4. Collect `review` / `no_review` intervals using participant self-report or an
   independently defined observer protocol. Record ambiguous intervals as
   `unknown` and pauses/seeks/buffering as `interrupted`. Do not infer ground
   truth from the detector score or bookmark itself. Keep scripted labels
   distinct from participant labels. Observer disagreements become unknown
   until resolved without consulting predictions.
5. Annotation intervals use backend milliseconds within the named recording,
   never browser/media time. The platform owner supplies clock mapping.
   For retrospective self-report, record the reported interval rather than
   assuming the button press is the behavioural onset. Log uncertainty in
   separate local annotation notes; exclude unresolved boundaries.

The CLI `python -m evaluation.labels --help` validates structured labels.
Example from the repository root after setting `PYTHONPATH`:

```powershell
python -m evaluation.labels --output data/labels.jsonl --participant p01 --session s01 --recording r01 --start-ms 10000 --end-ms 14000 --label unknown --source self_report
```

This is manual interval entry, not a live annotation UI. Check for conflicting
or overlapping labels and adjudicate before deriving evaluation intervals.

## Splits and tuning

Freeze the dataset manifest and exclusion rules before examining test outputs.
`participant_splits(recordings, seed=17)` assigns approximately 60/20/20 by
participant (minimum one validation and test participant). All sessions and
recordings from a participant stay together. The validator rejects duplicate
recordings and participant/session/recording IDs crossing boundaries. IDs must
be globally unique; a split function cannot detect copied data renamed with
different IDs. Deduplicate raw recordings before splitting.

The default question is generalisation to unseen participants. A personalised
model requires a separately declared held-out-session design and must not reuse
these results as unseen-participant evidence. Three participants is only the
minimum for valid partitioning, not enough to establish reliable performance.

Fit imputers, scalers, feature selection, per-person normalisation and learned
weights on training data only. Use validation data for thresholds, dwell,
cooldown, model choice and event-matching settings. A calibration learned from
a held-out participant is permitted only in a predeclared deployment-like
adaptation protocol, with separate unlabelled calibration and scoring intervals.
Freeze the bundle/hash, split manifest/hash, software versions, seed and rules
before the single final test pass. No learned preprocessing exists in v0.1.0.

## Event-level scoring and coverage

Use positive-duration intervals on the same recording clock. Predictions use
the union of all evidence windows that contributed to the sustained decision;
their end is not a measured lapse onset. IoU = intersection duration / union
duration. The initial proposed threshold is 0.3. Match within a recording only,
with maximum-cardinality one-to-one matching. Extra predictions around one
label count as false positives; unmatched labels count as false negatives.
Freeze matching rules on validation data before using held-out data.

Report precision, recall, F1 and false positives per hour of eligible, labelled
exposure, separately for EEG-only, gaze-only and combined mode. Undefined
denominators yield null. `event_metrics` expects prefiltered known eligible
intervals; callers must exclude/resolve candidates crossing unknown or
interrupted annotations before calling it. Include eligible negative time in
the exposure denominator. Do not silently score unknown as `no_review`.

Additionally report participant counts and per-participant results, eligible
exposure, abstained/unknown exposure, interruption exposure, decision delay,
quality-related failures, and sensitivity to matching threshold. Audit that
poor quality/missing/uncalibrated input emits no candidate, that interruption
clears pending decisions, and that resumption requires fresh in-epoch evidence.
Feedback (`replay`, `dismiss`, usefulness ratings) measures utility separately;
it is not an independent attention label.

## Current limitations and next handoffs

The initial bundle is a deterministic synthetic rule baseline, not a trained
attention model. Its arbitrary synthetic EEG threshold and gaze-outside rule
are unvalidated. There is no defensible held-out performance result or live
automatic mode yet. Sensor owners must confirm real input definitions, the
platform owner must wire the adapter and agree diagnostic transport, and the
team must collect independent labels before training/evaluation can proceed.
