"""Playback segment history and evidence mapping, with a fixed, known clock relationship."""

from __future__ import annotations

import pytest

from oxford_hack.contracts.payloads import BackendInterval, PlaybackState
from oxford_hack.timing.clock_sync import ClockEstimate
from oxford_hack.timing.playback import DEFAULT_MAPPING as CFG
from oxford_hack.timing.playback import PlaybackTimeline, TelemetryRejected

OFFSET = 50_000.0  # browser = backend + 50 s
CLOCK = ClockEstimate(OFFSET, 2.0, 3.0, 8, "synchronised")


class Player:
    """Feeds telemetry in browser time; `at(backend_ms)` converts for readability."""

    def __init__(self, video: str = "v1", duration: float | None = 600.0) -> None:
        self.tl = PlaybackTimeline(video)
        self.seq = 0
        self.duration = duration
        self.video = video

    def send(
        self,
        backend_ms: float,
        state: str,
        media: float,
        *,
        seg: str | None = None,
        rate: float = 1.0,
        event: str | None = None,
        video: str | None = None,
    ) -> None:
        self.seq += 1
        self.tl.ingest(
            PlaybackState(
                video_id=video or self.video,
                segment_id=seg,
                event=event or ("playing" if state == "playing" else "pause"),
                state=state,
                t_browser_ms=backend_ms + OFFSET,
                media_time_s=media,
                playback_rate=rate,  # type: ignore[arg-type]
                media_duration_s=self.duration,
                telemetry_seq=self.seq,
            ),
            backend_ms,
            staleness_ms=CFG.max_telemetry_staleness_ms,
        )

    def play_with_heartbeats(
        self, seg: str, start_ms: float, end_ms: float, media0: float, rate: float = 1.0
    ) -> None:
        t = start_ms
        self.send(t, "playing", media0, seg=seg, rate=rate)
        while t + 1000 <= end_ms:
            t += 1000
            self.send(
                t, "playing", media0 + (t - start_ms) / 1000 * rate, seg=seg, rate=rate, event="heartbeat"
            )

    def map(self, a: float, b: float):  # type: ignore[no-untyped-def]
        return self.tl.map_evidence(BackendInterval(start_backend_ms=a, end_backend_ms=b), CLOCK, CFG)


def test_maps_interval_inside_one_segment() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 30_000, media0=100.0)
    out = p.map(14_000, 18_000)
    assert out.mapped is not None
    assert out.mapped.segment_id == "s1"
    assert out.mapped.evidence_media.start_media_s == pytest.approx(104.0)
    assert out.mapped.evidence_media.end_media_s == pytest.approx(108.0)


def test_playback_rate_is_applied() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 30_000, media0=100.0, rate=1.5)
    out = p.map(14_000, 18_000)
    assert out.mapped is not None
    assert out.mapped.evidence_media.start_media_s == pytest.approx(106.0)
    assert out.mapped.evidence_media.end_media_s == pytest.approx(112.0)


def test_rate_change_mid_interval_crosses_boundary() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 20_000, media0=0.0)
    p.play_with_heartbeats("s2", 20_000, 30_000, media0=10.0, rate=2.0)
    assert p.map(18_000, 22_000).rejection == "crosses_boundary"
    ok = p.map(22_000, 26_000)
    assert ok.mapped is not None and ok.mapped.evidence_media.start_media_s == pytest.approx(14.0)


def test_pause_resume_never_interpolates_across_the_pause() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 20_000, media0=0.0)
    p.send(20_000, "paused", 10.0, event="pause")
    p.play_with_heartbeats("s2", 60_000, 80_000, media0=10.0)
    assert p.map(18_000, 22_000).rejection == "crosses_boundary"  # ends inside the pause
    assert p.map(30_000, 40_000).rejection == "not_playing"  # entirely paused
    assert p.map(18_000, 65_000).rejection == "crosses_boundary"  # spans the pause
    after = p.map(62_000, 66_000)
    assert after.mapped is not None and after.mapped.evidence_media.start_media_s == pytest.approx(12.0)


def test_buffering_ends_segment() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 20_000, media0=0.0)
    p.send(20_000, "buffering", 10.0, event="waiting")
    p.play_with_heartbeats("s2", 23_000, 30_000, media0=10.0)
    assert p.map(18_000, 24_000).rejection == "crosses_boundary"


def test_backward_and_forward_seek() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 20_000, media0=300.0)
    p.send(20_000, "seeking", 310.0, event="seeking")
    p.play_with_heartbeats("s2", 20_400, 30_000, media0=50.0)  # backward seek
    p.send(30_000, "seeking", 59.6, event="seeking")
    p.play_with_heartbeats("s3", 30_300, 40_000, media0=500.0)  # forward seek
    m1, m2, m3 = p.map(12_000, 16_000), p.map(22_000, 26_000), p.map(32_000, 36_000)
    assert m1.mapped and m1.mapped.evidence_media.start_media_s == pytest.approx(302.0)
    assert m2.mapped and m2.mapped.evidence_media.start_media_s == pytest.approx(51.6)
    assert m3.mapped and m3.mapped.evidence_media.start_media_s == pytest.approx(501.7)
    assert p.map(19_000, 21_000).rejection == "crosses_boundary"


def test_evidence_too_close_to_segment_start_is_rejected() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 20_000, media0=0.0)
    assert p.map(10_100, 14_000).rejection == "crosses_boundary"  # within margin of the start


def test_unconfirmed_tail_is_pending_until_telemetry_arrives() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 15_000, media0=0.0)
    assert p.map(12_000, 16_000).pending
    p.send(17_000, "playing", 7.0, seg="s1", event="heartbeat")
    assert p.map(12_000, 16_000).mapped is not None


def test_telemetry_gap_inside_segment_rejects_overlapping_evidence() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 15_000, media0=0.0)
    p.send(25_000, "playing", 15.0, seg="s1", event="heartbeat")  # 10 s without telemetry
    p.send(26_000, "playing", 16.0, seg="s1", event="heartbeat")
    assert p.map(16_000, 20_000).rejection == "stale_telemetry"
    assert p.map(11_000, 14_000).mapped is not None


def test_discontinuity_breaks_segment() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 15_000, media0=0.0)
    p.send(16_000, "playing", 90.0, seg="s1", event="heartbeat")  # jumped without a seek event
    assert p.tl.discontinuities == 1
    assert p.tl.open_segment is None
    assert p.map(12_000, 14_000).mapped is not None  # history before the jump stays valid


def test_out_of_order_and_reused_segments_rejected() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 12_000, media0=0.0)
    with pytest.raises(TelemetryRejected) as exc:
        p.tl.ingest(
            PlaybackState(
                video_id="v1",
                segment_id="s1",
                event="heartbeat",
                state="playing",
                t_browser_ms=OFFSET + 11_500,
                media_time_s=1.5,
                playback_rate=1.0,
                media_duration_s=None,
                telemetry_seq=1,
            ),
            11_500,
            staleness_ms=2500,
        )
    assert exc.value.code == "out_of_order"
    p.send(13_000, "paused", 3.0)
    with pytest.raises(TelemetryRejected):
        p.send(14_000, "playing", 3.0, seg="s1")


def test_video_mismatch_rejected() -> None:
    p = Player()
    with pytest.raises(TelemetryRejected) as exc:
        p.send(10_000, "playing", 0.0, seg="s1", video="other-video")
    assert exc.value.code == "video_mismatch"


def test_mapping_beyond_duration_rejected() -> None:
    p = Player(duration=20.0)
    p.play_with_heartbeats("s1", 10_000, 40_000, media0=0.0)
    assert p.map(30_000, 34_000).rejection == "out_of_media_bounds"


def test_clock_requirements() -> None:
    p = Player()
    p.play_with_heartbeats("s1", 10_000, 30_000, media0=0.0)
    interval = BackendInterval(start_backend_ms=14_000, end_backend_ms=18_000)
    assert p.tl.map_evidence(interval, None, CFG).rejection == "clock_unsynchronised"
    loose = ClockEstimate(OFFSET, 500.0, 900.0, 8, "degraded")
    assert p.tl.map_evidence(interval, loose, CFG).rejection == "clock_uncertain"


def test_eligibility_reasons() -> None:
    p = Player()
    assert p.tl.eligibility(9_000, CLOCK, CFG).reason == "not_started"
    p.play_with_heartbeats("s1", 10_000, 12_000, media0=0.0)
    e = p.tl.eligibility(12_100, CLOCK, CFG)
    assert e.eligible and e.segment_id == "s1" and e.since_backend_ms == pytest.approx(10_000)
    assert p.tl.eligibility(12_100, None, CFG).reason == "clock_unsynchronised"
    assert p.tl.eligibility(20_000, CLOCK, CFG).reason == "stale_telemetry"
    p.send(20_000, "seeking", 10.0, event="seeking")
    assert p.tl.eligibility(20_000, CLOCK, CFG).reason == "seeking"


def test_history_expiry() -> None:
    p = Player()
    p.tl.history_ms = 60_000
    p.play_with_heartbeats("s1", 10_000, 12_000, media0=0.0)
    p.send(12_000, "paused", 2.0)
    p.play_with_heartbeats("s2", 200_000, 202_000, media0=2.0)
    p.tl.prune(OFFSET + 202_000)
    assert p.map(10_500, 11_500).rejection == "history_expired"
