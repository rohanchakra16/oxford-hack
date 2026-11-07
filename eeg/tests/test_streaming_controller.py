import time

import numpy as np

from eeg.acquisition import MockEEGDevice
from eeg.processing.signal_preprocessor import EEGPreprocessor
from eeg.realtime.attention_classifier import StubAttentionClassifier
from eeg.realtime.feature_extractor import EEGFeatureExtractor
from eeg.realtime.feature_registry import FeatureRegistry
from eeg.realtime.streaming_controller import StreamingController


def make_controller(tmp_path=None, on_frame=None):
    device = MockEEGDevice(sampling_frequency_hz=100, channel_count=2, seed=2)
    device.connect()
    registry = FeatureRegistry()
    registry.register(
        "custom",
        lambda window, rate, info, config=None: float(np.mean(np.abs(window))) / 100,
    )
    extractor = EEGFeatureExtractor(registry)
    classifier = StubAttentionClassifier(expected_features=("custom",))
    return StreamingController(
        device,
        EEGPreprocessor(bandpass=None),
        extractor,
        classifier,
        on_frame=on_frame,
        output_capacity=10,
    ), device


def test_end_to_end_windows_and_cleanup() -> None:
    controller, device = make_controller()
    controller.start()
    frames = []
    deadline = time.monotonic() + 4
    while len(frames) < 3 and time.monotonic() < deadline:
        try:
            frames.append(controller.get_frame(timeout=0.1))
        except Exception:
            pass
    controller.stop()

    assert len(frames) >= 2
    assert all(frame["frame_index"] == index for index, frame in enumerate(frames))
    assert all(frame["prediction"]["model_type"] == "stub" for frame in frames)
    assert all(frame["window_end_timestamp"] > frame["window_start_timestamp"] for frame in frames)
    assert all(frame["sample_indices"][1] - frame["sample_indices"][0] + 1 == 200 for frame in frames)
    assert controller.error is None
    assert not controller._threads
    device.disconnect()


def test_update_interval_and_overlap_are_sample_derived() -> None:
    controller, device = make_controller()
    assert controller.window_overlap == 0.75
    controller.start()
    first = controller.get_frame(timeout=4)
    second = controller.get_frame(timeout=4)
    controller.stop()
    assert second["sample_indices"][0] > first["sample_indices"][0]
    assert second["sample_indices"][0] - first["sample_indices"][0] == 50
    assert controller.get_stats().missed_update_deadlines == 0
    device.disconnect()


def test_failing_feature_still_emits_invalid_prediction() -> None:
    device = MockEEGDevice(sampling_frequency_hz=100, channel_count=1, seed=1)
    device.connect()
    registry = FeatureRegistry()
    registry.register("bad", lambda *args: (_ for _ in ()).throw(RuntimeError("failed")))
    controller = StreamingController(
        device,
        EEGPreprocessor(bandpass=None),
        EEGFeatureExtractor(registry),
        StubAttentionClassifier(expected_features=("bad",)),
    )
    controller.start()
    frame = controller.get_frame(timeout=4)
    controller.stop()
    assert frame["features"]["bad"]["valid"] is False
    assert frame["prediction_valid"] is False
    device.disconnect()
