# Lecture attention and educational questions — prototype 0.1.0

Task #27. Owner @Seikaro. Only `inference/` and `evaluation/` are changed.

## Implementation brief

Build a deterministic, runnable lecture inference/evaluation prototype that
accepts explicitly synthetic window scores, estimates four attention levels,
retains unknown/interrupted states, records merged review ranges, and schedules
placeholder questions for educational viewing. Normal viewing produces review
reminders only. Educational viewing chooses immediate questions or questions
after the lecture. Preserve a minimum 30-second prompt interval, stable IDs,
session isolation, quality gates and playback boundaries. Provide an evaluation
replay harness and a concrete handoff to the existing player/transcript owners.

These levels are **prototype estimates**. “No attention” means the lowest bin
of a usable demo score; it does not establish that a person paid no attention.
This code accepts no live sensor provenance and enables no live automatic mode.

## Run

From the repository root, use Python 3.11–3.13 and the environment in
`inference/README.md`. No scientific packages, model training, network, video,
hardware, or API keys are required for the synthetic prototype.

```powershell
$env:PYTHONPATH = "$PWD;$PWD/platform/src"
inference/.venv/Scripts/python.exe -m evaluation.lecture_replay --mode normal
inference/.venv/Scripts/python.exe -m evaluation.lecture_replay --mode educational-immediate
inference/.venv/Scripts/python.exe -m evaluation.lecture_replay --mode educational-end --interactive
inference/.venv/Scripts/python.exe -m evaluation.lecture_replay --suite
inference/.venv/Scripts/python.exe -m evaluation.lecture_replay --mode educational-immediate --json
inference/.venv/Scripts/python.exe -m pytest inference/tests evaluation/tests -q
```

The CLI shows a review-range/reminder table, estimate counts, question text and
scheduling metrics. `--json` includes the complete event trace. Default replay
uses scripted instant presentation/answers to exercise the queue; these answers
are not knowledge-test results. `--interactive` leaves questions unresolved and
supports `list`, `answer <text>`, `dismiss`, `replay`, `replay <segment-id>`,
`complete-replay`, `next` and `quit`. `next` advances the demo clock by 30 s.
Replay prints a command for the player; this terminal does not play a video.
`complete-replay` acknowledges completion in this terminal simulation only.
The trace is processed before this terminal interaction, so immediate-mode
interactive questions may be answered after the replay has finished; the
noninteractive event trace records their actual scheduled request times.

Edit a copy of `inference/bundles/lecture-prototype-0.1.0.json` and pass
`--config <path>` to change thresholds, smoothing, dwell and merging. The
`--mode` option chooses the viewing mode and overrides mode/timing in the file.
On POSIX use `.venv/bin/python` and `export PYTHONPATH="$PWD:$PWD/platform/src"`.

## Estimation and review segments

| Setting | Default | Meaning |
| --- | ---: | --- |
| `no_attention_max` | 0.2 | Usable smoothed demo score ≤0.2 → no attention |
| `low_attention_max` | 0.4 | Score >0.2 and ≤0.4 → low attention; both low bins qualify for loss |
| `medium_attention_max` | 0.7 | Score >0.4 and ≤0.7 → medium; above 0.7 → high |
| `smoothing_tau_ms` | 2000 | Elapsed-time exponential smoothing; zero disables it |
| `minimum_loss_ms` | 4000 | Sustained low/no score measured between advancing evidence endpoints |
| `recovery_min`, `recovery_ms` | 0.5, 2000 | Sustained recovery above a separate threshold closes a loss episode |
| `merge_gap_s` | 5 | Merge nearby/overlapping episodes within the same uninterrupted continuity |
| `stale_after_ms` | 2000 | Reject future/stale evidence; timer polling also invalidates stale estimates |
| `max_evidence_step_ms` | 5000 | A larger gap resets smoothing and dwell |
| `question_cooldown_ms` | 30000 | Hard lower bound: values below 30 s are rejected |

Scores are dimensionless demo inputs, not focus percentages. The synthetic
fixture uses one-second evidence windows. Four-second EEGMAT windows are also
supported. Overlapping windows advance dwell by endpoint time, not by summing
window durations; polling/repeating an observation cannot accumulate evidence.

Missing/unusable/null scores yield **unknown**, with a null smoothed score.
Pause, seek, buffering and replay yield an **interrupted** status with an unknown
level. They close any open review segment at its last low evidence, clear
pending decisions and require a complete fresh window within the next playback
epoch. Recovery uses hysteresis, limiting repeated triggers near the threshold.

Events are upserts: `review_segment` has a stable `segmentId`, increasing
`revision`, media range, worst qualifying level, source and episode count.
Later evidence can extend the same segment. A nearby new loss may merge into
it without requesting another question. An unknown/playback boundary prevents
merging across the interruption. The session tracks observed media intervals:
explicit replay and fully observed seek-back intervals cannot generate duplicate
segments/prompts. A previously skipped, unobserved part can still be evaluated
on its first visit. Repeated visits are not independently assessed in v0.1.0.

## Viewing modes and question interaction

| Mode | Behaviour |
| --- | --- |
| Normal | Emit/upsert review segments; show reminders/bookmarks. Never queue questions. |
| Educational, immediate | Queue once a loss qualifies; request immediately when a question slot and cooldown permit. |
| Educational, end of lecture | Collect segments; the first genuine ended tick opens the quiz queue, ordered by media start. |

One unresolved request is allowed at a time. Extra segments wait in a queue,
including during cooldown. Answering or dismissing does not reset the cooldown
or change the attention label. Each segment can request at most one question.
Repeated ended events cannot rebuild the queue; an ended event during explicit
review replay does not start a quiz. Modes are fixed per prototype session.

The scheduler reserves the prompt time at request issuance. The UI must also
acknowledge actual display with a `presented` action. A delayed acknowledgement
moves the next allowed prompt time later, preserving at least 30 s between
actual presentations. Answer/dismiss/replay implicitly acknowledge an otherwise
unacknowledged request. Backend **receipt time** is used for actions, so a delayed
UI message makes the cooldown conservative. Do not use media time for cooldown:
seeking backwards, pausing or changing playback rate cannot shorten it.

Prompts never pause or seek automatically (`pausePlayback: false`). Answers are
free text, retained in memory by question ID; no grading or correctness is
claimed. `QuestionProvider(segment, transcript_excerpts) -> str` is injectable;
the default returns an explicitly marked placeholder. All questions remain
marked `placeholder: true` in this version. A real provider must define content,
grading and provenance explicitly in a future version.

## API and player handoff

Owner-facing source: `lecture_types.py` (validated camelCase JSON models),
`lecture.py` (state machine), and `lecture_questions.py` (provider/scheduler).
Wire example: `evaluation/fixtures/lecture-question-request.json`.

```python
prototype = LecturePrototype(session_id, video_id, duration_s,
    config=LectureConfig(mode="educational", question_timing="immediate"),
    transcript=excerpts)
events = prototype.advance(PlaybackTick.model_validate(tick_json))
events += prototype.poll(now_backend_ms)
events = prototype.act(QuestionAction.model_validate(action_json))
events = prototype.request_replay(segment_id, action_id, now_backend_ms)
```

`question_request` carries `questionId`, `segmentId`, `sessionId`, `videoId`
(lecture ID), `lectureRevision`, `affectedRange {startMediaS,endMediaS}`,
`attentionLevel`, `triggerReason`, up to eight overlapping `transcriptContext`
excerpts, monotonic request time, timing, placeholder text and demo provenance.
The range/context are immutable snapshots at request time. Resolve the latest
segment via `segmentId` when replaying, since it may have grown or merged.

The public `PlayerHandle` and transcript code were reviewed in
`frontend/src/player/{index.ts,LecturePlayer.tsx,controller.ts}`,
`frontend/src/transcript/{index.ts,sentences.ts,load.ts}` and the merged product
composition. Coordination request posted to @aryanmorarji, @Betty505 and
@rohanchakra16 on Message Board #1; frontend wiring is their next handoff.

| Existing API / owner | Integration responsibility |
| --- | --- |
| Aryan: `player.getState()` | Read media time, duration, pause/seek/buffer/ended and `replay`; all media units are seconds. |
| Aryan/P5: `ReviewClient` snapshot eligibility | Supply segment ID/eligibility boundary; preserve session/video identity. Keep `attachMediaElement` as the single telemetry path. |
| Aryan: `TranscriptPanel.onTranscriptChange` | Supply available sentence context through `toTranscriptContext`; no second caption parser is added. |
| Betty: question UI | Render one request; send presented/answer/dismiss/replay with stable action IDs. Keep prototype/source badges. |
| Aryan/Betty: explicit replay | Execute emitted `playback_command` using `player.replayRange(startMediaS,endMediaS)`. Optionally adjust start with `replayStartFor` under the existing sentence rule. |
| Aryan: player replay status | Keep replay suppression active until actual replay/seek completes; report playback changes back to the orchestrator. |
| Rohan: clocks/transport | Use backend receipt monotonic milliseconds for scheduling/actions; map evidence ranges through the existing platform layer before orchestration. |

Deduplicate outbound effects by `commandId` / `questionId`, upsert segment
revisions, and verify session/video identity before executing a command. A
retry of the same action is harmless; reusing an action ID with different
content is rejected. A terminal answer/dismissal cannot be changed by retries.
`request_replay` works without a question, including normal mode.

**This is a standalone orchestration prototype, not the live InferenceAdapter
or a shared WebSocket extension.** Its version is `lecture-prototype-0.1.0`,
distinct from shared schema 0.1.0. Its frame ranges are explicit synthetic
fixture mappings or hypothetical EEGMAT timelines. It performs no device,
browser or media clock conversion. Do not send these events to the existing
strict shared-message parser. Live adoption requires P5's agreed contract and
mapping, evaluation-backed input semantics, and owner-implemented UI wiring.
The current production player and sensor paths remain unchanged.

## Optional EEGMAT demo

Create workload predictions using the earlier instructions in
`evaluation/EEGMAT.md`, then pass that JSON output as `--workload-json <path>`.
The converter assumes **p(arithmetic) = demo score** only to exercise the same
four-bin/scheduling code on real-derived values. It constructs a fake lecture
timeline beginning at zero, labelled `eegmat_demo` / `eegmat_demo_timeline`.
This mapping is unvalidated and cannot establish attention, lecture timestamps,
or attention-loss accuracy. It requires timestamped windows even for unknown
predictions and excludes unrelated transcripts from the synthetic fixture.

## Evaluation and later lecturer insights

`python -m evaluation.lecture_replay --suite` runs three synthetic scenarios
(sustained bouts, steady high, wholly unusable input) in all three behaviours.
`--write-artifacts` regenerates `evaluation/fixtures/lecture-report.json` and
the example question request. The primary 120 s fixture yields:

| Behaviour | Review segments | Questions | Minimum request interval |
| --- | ---: | ---: | ---: |
| Normal | 4 | 0 | n/a |
| Educational immediate | 4 | 4 | 30 s |
| Educational end | 4 | 4 | 30 s; first at lecture end |

Both control scenarios yield zero segments/questions in every mode. The report
also includes qualifying episodes, merges, level/unknown estimate-event counts and
questions per elapsed replay minute. That average includes the question queue
drain after playback; first/last sample boundaries mean it is not a rolling
per-minute rate cap. The actual invariant is ≥30,000 ms between requests and
between acknowledged presentations. Scripted instant answers are not evidence
of user comprehension. Accuracy and false-positive rate remain null because
these scenarios have no independent attention truth. Evaluate future labelled
recordings with the existing `evaluation.metrics` and leakage-safe protocol.

Review segments carry video/lecture revision, session, media range, prototype
source and configuration-version context, providing the inputs for future
per-lecture time-bin summaries. A canonical course lecture ID will be needed
before comparing students: local file metadata IDs alone do not establish that
two uploads are the same lecture. No cross-student aggregation, lecturer
dashboard, persistence, or participant identifiers are implemented here.
