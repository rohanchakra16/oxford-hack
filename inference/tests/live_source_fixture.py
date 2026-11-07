"""Controlled model windows for main-app integration tests. NEVER a device source."""

import os
from threading import Event, Thread

from oxford_hack.contracts.payloads import EegFeatureWindow

from inference.demo import eeg_window


class ControlledSource:
    stream_id = "controlled-model-test-only"

    def __init__(self):
        self.stop_event = Event()
        self.thread = None

    def start(self, sink, clock):
        def run():
            while not self.stop_event.wait(0.5):
                now = clock.now_ms()
                if now < 2000:
                    continue
                data = eeg_window().model_dump(by_alias=False)
                data.update(
                    window_id=f"controlled-{now}",
                    stream_id=self.stream_id,
                    feature_set_version="lecture-attention-0.1.0",
                    evidence={
                        "start_backend_ms": now - 2000,
                        "end_backend_ms": now - 10,
                    },
                    t_processed_backend_ms=now,
                    features=[
                        {
                            "name": "attention_score",
                            "unit": "score_0_100",
                            "channel": None,
                            "value": 5.0,
                            "missing_reason": None,
                        }
                    ],
                    provenance={
                        "run_kind": "live",
                        "producer": "lecture-attention-model",
                        "producer_version": "controlled-test",
                    },
                )
                sink.publish_window(EegFeatureWindow.model_validate(data))

        self.thread = Thread(target=run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)


def make_source():
    if os.environ.get("OXFORD_TEST_EEG_SOURCE") != "1":
        raise ValueError(
            "Controlled EEG fixture is test-only; not a live headset or classifier"
        )
    return ControlledSource()
