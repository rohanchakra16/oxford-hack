import pytest
from pydantic import ValidationError

from inference.lecture import LecturePrototype
from inference.lecture_types import (
    DemoEvidence,
    LectureConfig,
    MediaRange,
    PlaybackTick,
    QuestionAction,
    TranscriptExcerpt,
)


def config(**values):
    return LectureConfig(smoothing_tau_ms=0.0, minimum_loss_ms=2000.0, recovery_ms=1000.0, **values)


def engine(**values):
    return LecturePrototype(
        "session",
        "video",
        200.0,
        config=config(**values),
        transcript=[
            TranscriptExcerpt(start_media_s=0.0, end_media_s=20.0, text="Scripted transcript context.")
        ],
    )


def tick(t, score=0.1, **changes):
    values = dict(
        session_id="session",
        video_id="video",
        seq=t,
        backend_ms=t * 1000.0,
        media_s=float(t),
        duration_s=200.0,
        state="playing",
        segment_id="playback-1",
        eligible_since_backend_ms=0.0,
        evidence=DemoEvidence(
            evidence_id=f"window-{t}",
            start_backend_ms=(t - 1) * 1000.0,
            end_backend_ms=t * 1000.0,
            media_range=MediaRange(start_media_s=t - 1.0, end_media_s=float(t)),
            score=score,
        ),
    )
    values.update(changes)
    return PlaybackTick(**values)


def feed(e, start, end, score=0.1):
    return [event for t in range(start, end + 1) for event in e.advance(tick(t, score))]


def requests(events):
    return [event["payload"] for event in events if event["type"] == "question_request"]


def act(e, action, suffix="", at=None, answer=None):
    qid = e.questions.active_id
    return e.act(
        QuestionAction(
            action_id=f"{action}-{qid}-{suffix}",
            question_id=qid,
            backend_ms=e.now if at is None else at,
            action=action,
            answer=answer,
        )
    )


@pytest.mark.parametrize(
    "score,level",
    [
        (0.0, "no attention"),
        (0.2, "no attention"),
        (0.3, "low attention"),
        (0.4, "low attention"),
        (0.6, "medium attention"),
        (0.7, "medium attention"),
        (0.9, "high attention"),
    ],
)
def test_four_level_boundaries(score, level):
    e = engine()
    e.advance(tick(1, score))
    assert e.status["level"] == level
    assert not e.segments


def test_short_fluctuation_and_smoothing_do_not_trigger_loss():
    e = LecturePrototype("session", "video", 200.0)
    feed(e, 1, 5, 0.9)
    e.advance(tick(6, 0.0))
    feed(e, 7, 15, 0.9)
    assert not e.segments


@pytest.mark.parametrize(
    "bad",
    [
        None,
        DemoEvidence(
            evidence_id="bad",
            start_backend_ms=3000.0,
            end_backend_ms=4000.0,
            media_range=MediaRange(start_media_s=3.0, end_media_s=4.0),
            score=0.0,
            usable=False,
        ),
    ],
)
def test_quality_failure_is_unknown_and_breaks_dwell(bad):
    e = engine()
    feed(e, 1, 2)
    e.advance(tick(4, evidence=bad))
    assert e.status["level"] == "unknown" and e.status["score"] is None
    feed(e, 5, 6)
    assert not e.segments
    e.advance(tick(7))
    assert len(e.segments) == 1


def test_recovery_hysteresis_and_nearby_episodes_merge_with_one_question():
    e = engine(mode="educational")
    first = requests(feed(e, 1, 3))[0]
    act(e, "dismiss")
    feed(e, 4, 5, 0.9)
    assert next(iter(e.segments.values())).closed
    events = feed(e, 6, 8)
    assert len(e.segments) == 1
    segment = next(iter(e.segments.values()))
    assert segment.episode_count == 2 and segment.media_range.end_media_s == 8.0
    assert first["segmentId"] == segment.segment_id
    assert not requests(events)
    assert len(e.questions.requests) == 1


def test_normal_mode_records_reminders_and_supports_replay_without_questions():
    e = engine()
    assert not requests(feed(e, 1, 3))
    segment = next(iter(e.segments.values()))
    command = e.request_replay(segment.segment_id, "manual-replay", e.now)[-1]["payload"]
    assert (command["startMediaS"], command["endMediaS"]) == (0.0, 3.0)
    assert e.request_replay(segment.segment_id, "manual-replay", e.now) == []
    assert not e.questions.requests


def test_30_second_cooldown_including_dismissed_false_positives():
    e = engine(mode="educational")
    first = requests(feed(e, 1, 3))[0]
    act(e, "presented")
    act(e, "dismiss")  # A user dismissal does not clear the rate limit.
    feed(e, 4, 12, 0.9)
    assert not requests(feed(e, 13, 15))
    assert not requests(feed(e, 16, 32, 0.9))
    second = requests(e.advance(tick(33, 0.9)))[0]
    assert second["requestedBackendMs"] - first["requestedBackendMs"] == 30000.0


def test_delayed_ui_presentation_restarts_cooldown_at_display_time():
    e = engine(mode="educational")
    feed(e, 1, 3)
    feed(e, 4, 20, 0.9)
    act(e, "presented")  # delivery was delayed until 20 s
    act(e, "answer", answer="My response")
    feed(e, 21, 23)
    assert not requests(feed(e, 24, 49, 0.9))
    assert len(requests(e.advance(tick(50, 0.9)))) == 1


def test_one_unresolved_question_prevents_prompt_stacking():
    e = engine(mode="educational")
    feed(e, 1, 3)
    feed(e, 4, 40, 0.9)
    assert not requests(feed(e, 41, 43))
    assert len(e.questions.requests) == 1 and len(e.questions.pending) == 1


def test_end_of_lecture_queue_paced_idempotent_and_linked_to_context():
    e = engine(mode="educational", question_timing="end_of_lecture")
    assert not requests(feed(e, 1, 3))
    feed(e, 4, 20, 0.9)
    assert not requests(feed(e, 21, 23))
    end = tick(24, state="ended", segment_id=None, eligible_since_backend_ms=None, evidence=None)
    question = requests(e.advance(end))[0]
    assert question["transcriptContext"][0]["text"] == "Scripted transcript context."
    assert question["affectedRange"] == {"startMediaS": 0.0, "endMediaS": 3.0}
    assert question["pausePlayback"] is False
    assert not requests(e.advance(end.model_copy(update={"seq": 25, "backend_ms": 25000.0})))
    act(e, "presented")
    act(e, "answer", answer="A local answer")
    assert not e.poll(54999.0)
    second = requests(e.poll(55000.0))[0]
    assert second["segmentId"] != question["segmentId"]
    assert not second["transcriptContext"]
    assert len(e.questions.requests) == 2


def test_pause_separates_segments_and_rejects_cross_boundary_windows():
    e = engine(mode="educational")
    feed(e, 1, 3)
    act(e, "dismiss")
    e.advance(tick(4, state="paused", segment_id=None, eligible_since_backend_ms=None, evidence=None))
    e.advance(tick(5, segment_id="playback-2", eligible_since_backend_ms=5000.0))
    assert e.status["state"] == "unknown"
    for t in (6, 7, 8):
        e.advance(tick(t, segment_id="playback-2", eligible_since_backend_ms=5000.0))
    assert len(e.segments) == 2  # no merging across a pause even though media ranges are close
    assert len(e.questions.requests) == 1  # cooldown survives pause/new epoch


def test_duplicate_samples_and_out_of_order_ticks_cannot_accumulate_dwell():
    e = engine()
    original = tick(1)
    e.advance(original)
    assert e.advance(original) == []
    e.advance(tick(2, evidence=original.evidence))
    assert not e.segments
    assert e.advance(tick(1)) == []
    e.poll(10000.0)
    assert e.status["level"] == "unknown"


def test_manual_seek_back_and_review_replay_do_not_duplicate_segments_or_prompts():
    e = engine(mode="educational")
    feed(e, 1, 3)
    qid = e.questions.active_id
    command = act(e, "replay")[-1]["payload"]
    assert command["endMediaS"] == 3.0
    for t in range(4, 9):
        evidence = DemoEvidence(
            evidence_id=f"rewatch-{t}",
            start_backend_ms=(t - 1) * 1000.0,
            end_backend_ms=t * 1000.0,
            media_range=MediaRange(start_media_s=0.0, end_media_s=1.0),
            score=0.0,
        )
        e.advance(
            tick(
                t,
                media_s=1.0,
                segment_id="rewatch",
                eligible_since_backend_ms=3000.0,
                replaying=t < 6,
                evidence=evidence,
            )
        )
    assert len(e.segments) == len(e.questions.requests) == 1
    assert e.questions.active_id == qid


def test_answer_and_dismiss_retry_idempotency():
    e = engine(mode="educational")
    feed(e, 1, 3)
    qid = e.questions.active_id
    answer = QuestionAction(
        action_id="answer",
        question_id=qid,
        backend_ms=e.now,
        action="answer",
        answer="The concept was ion channels.",
    )
    assert e.act(answer)[0]["type"] == "question_feedback"
    assert e.act(answer) == []
    assert e.questions.answers[qid] == answer.answer
    assert (
        e.act(
            QuestionAction(
                action_id="dismiss-after-answer", question_id=qid, backend_ms=e.now, action="dismiss"
            )
        )
        == []
    )
    with pytest.raises(ValueError):
        e.act(answer.model_copy(update={"answer": "different"}))


def test_mapped_range_accuracy_at_double_speed_and_bad_mapping_rejected():
    e = engine()
    for t in range(1, 4):
        evidence = tick(t).evidence.model_copy(
            update={"media_range": MediaRange(start_media_s=2 * (t - 1.0), end_media_s=2.0 * t)}
        )
        e.advance(tick(t, media_s=2.0 * t, playback_rate=2.0, evidence=evidence))
    segment = next(iter(e.segments.values()))
    assert segment.media_range.end_media_s == 6.0
    assert e.request_replay(segment.segment_id, "replay-2x", e.now)[-1]["payload"]["endMediaS"] == 6.0
    bad = engine()
    bad.advance(
        tick(
            1,
            evidence=tick(1).evidence.model_copy(
                update={"media_range": MediaRange(start_media_s=0.0, end_media_s=10.0)}
            ),
        )
    )
    assert bad.status["level"] == "unknown" and not bad.segments


def test_session_fences_and_invalid_configuration():
    e = engine()
    with pytest.raises(ValueError):
        e.advance(tick(1, session_id="other"))
    for values in (
        {"question_cooldown_ms": 29000.0},
        {"low_attention_max": 0.1},
        {"smoothing_tau_ms": float("nan")},
        {"recovery_min": 0.4},
    ):
        with pytest.raises(ValidationError):
            LectureConfig.model_validate(values)
    with pytest.raises(ValidationError):
        QuestionAction(action_id="bad", question_id="q", backend_ms=1.0, action="answer", answer=" ")


def test_placeholder_provider_can_be_replaced_without_changing_scheduler():
    e = LecturePrototype(
        "session",
        "video",
        200.0,
        config=config(mode="educational"),
        question_provider=lambda segment, context: "[Placeholder] Explain the key concept.",
    )
    question = requests(feed(e, 1, 3))[0]
    assert question["questionText"] == "[Placeholder] Explain the key concept."


def test_ended_during_review_replay_does_not_start_end_quiz():
    e = engine(mode="educational", question_timing="end_of_lecture")
    feed(e, 1, 3)
    events = e.advance(
        tick(4, state="ended", replaying=True, segment_id=None, eligible_since_backend_ms=None, evidence=None)
    )
    assert not e.ended and not requests(events)


def test_short_quality_gap_waits_for_complete_fresh_overlapping_window():
    e = engine()
    feed(e, 1, 3, 0.9)
    e.advance(tick(4, evidence=None))
    for t in (5, 6, 7):
        evidence = tick(t).evidence.model_copy(
            update={
                "start_backend_ms": (t - 4) * 1000.0,
                "media_range": MediaRange(start_media_s=t - 4.0, end_media_s=float(t)),
            }
        )
        e.advance(tick(t, evidence=evidence))
        assert e.status["level"] == "unknown"
    evidence = tick(8).evidence.model_copy(
        update={"start_backend_ms": 4000.0, "media_range": MediaRange(start_media_s=4.0, end_media_s=8.0)}
    )
    e.advance(tick(8, evidence=evidence))
    assert e.status["level"] == "no attention"  # waiting did not push the boundary indefinitely
