# Record and replay (Person 5)

Recordings are JSONL: line 1 is a header, every other line is one accepted message. Format and code:
`src/platform/src/oxford_hack/harness/replay.py`.

```json
{"format": "oxford-hack-recording", "formatVersion": 1, "schemaVersion": "0.1.0", "synthetic": true,
 "description": "...", "backendStartMs": 10000.0,
 "detector": {"detectorId": "...", "detectorVersion": "...", "configVersion": "...", "evaluatedModes": []} }
{"atMs": 10500.0, "from": "clock", "offsetBrowserMinusBackendMs": 123456.7}
{"atMs": 10520.0, "from": "browser", "message": { ...envelope... }}
{"atMs": 15100.0, "from": "eeg", "message": { ...eeg_features / eeg_status... }}
{"atMs": 16050.0, "from": "inference", "message": { ...review_candidate... }}
```

`atMs` is the backend clock at acceptance. Replay re-runs everything through a fresh hub on a manual clock with a
simulated browser at the recorded offset, so output is **deterministic**.

```bash
cd src/platform
uv run oxford-backend replay ../contracts/fixtures/recordings/synthetic-session.v1.jsonl
uv run python scripts/make_sample_recording.py --check   # the committed sample is reproducible
```

Rules:

- Every replayed session, message and bookmark is relabelled `runKind: "replay"`.
- A recording whose header says `synthetic: true` replays under the simulation-only policy (the detector may
  publish from unevaluated modes). Real recordings only publish for modes in `evaluatedModes`.
- A recording with a different `schemaVersion` is refused, not guessed at.
- Real recordings (any EEG or webcam data) must not be committed. To record, use the opt-in `JsonlRecorder` and write
  under `.local/`. Only the synthetic sample lives in `src/contracts/fixtures/recordings/`.
