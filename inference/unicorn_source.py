"""Physical Unicorn EegSource. No mock, EDF, or scripted fallback.

Reuses the EEG owner's Unicorn driver, preprocessing and StreamingController.
Only SDK-labelled EEG channels with confirmed microvolt units are selected.
Features are real spectral measurements; calibration/scoring stays in inference.
"""

import queue
import time
import logging
from collections import deque
from threading import Event, Lock, Thread
from uuid import uuid4

from oxford_hack.contracts.payloads import EegDeviceInfo, EegFeatureWindow, EegStatus

from .unicorn_baseline import BANDS, FEATURE_SET, PRODUCER, spectral_values


class EegChannels:
    def __init__(self, device):
        self.device = device
        self.indices = []
        self.names = ()
        self.bounds = deque(maxlen=4096)
        self.lock = Lock()

    def connect(self):
        self.device.connect()
        info = self.device.get_device_info()
        channels = info.get("channels", [])
        self.indices = [i for i, c in enumerate(channels) if c.get("type") == "eeg"]
        if not self.indices or any(
            channels[i].get("unit") not in {"uV", "µV", "μV"} for i in self.indices
        ):
            raise ValueError(
                "Unicorn must report EEG channel types and microvolt units"
            )
        if info.get("timestamp_source") != "host_monotonic_at_retrieval":
            raise ValueError("Unicorn timestamp mapping must be confirmed")
        self.names = tuple(channels[i]["name"] for i in self.indices)

    def get_samples(self, num_samples=5):
        from eeg.acquisition.base_device import SampleBatch

        started = time.monotonic()
        batch = self.device.get_samples(num_samples)
        elapsed_ms = (time.monotonic() - started) * 1000
        # Host retrieval timestamps are approximate acquisition anchors. Include
        # the full batch duration and measured SDK call time, never claim zero error.
        bound = elapsed_ms + num_samples / batch.sampling_frequency_hz * 1000 + 5
        with self.lock:
            self.bounds.append(
                (int(batch.sample_indices[0]), int(batch.sample_indices[-1]), bound)
            )
        return SampleBatch(
            batch.samples[:, self.indices],
            batch.timestamps,
            batch.sample_indices,
            self.names,
            batch.sampling_frequency_hz,
            "uV",
        )

    def uncertainty(self, first, last):
        with self.lock:
            spans = [
                (a, b, bound) for a, b, bound in self.bounds if b >= first and a <= last
            ]
        cursor = first
        for a, b, _ in spans:
            if a > cursor:
                return None
            cursor = max(cursor, b + 1)
        return (
            max((bound for _, _, bound in spans), default=1000)
            if cursor > last
            else None
        )

    def get_device_info(self):
        return {
            **self.device.get_device_info(),
            "channel_names": self.names,
            "channel_count": len(self.names),
            "signal_units": "uV",
        }

    def start_streaming(self):
        self.device.start_streaming()

    def stop_streaming(self):
        self.device.stop_streaming()

    def disconnect(self):
        self.device.disconnect()


class SpectralExtractor:
    def extract(self, samples, sampling_rate, channel_info, **kwargs):
        names = channel_info["channel_names"]
        try:
            values = spectral_values(samples, sampling_rate)
            features = {
                f"{channel}:{band}": {"value": float(values[i, j]), "valid": True}
                for i, channel in enumerate(names)
                for j, (band, _, _) in enumerate(BANDS)
            }
        except ValueError:
            features = {
                f"{channel}:{band}": {"value": None, "valid": False}
                for channel in names
                for band, _, _ in BANDS
            }
        return {
            "features": features,
            "execution_times_ms": {},
            "timestamp": kwargs.get("timestamp"),
        }


class FeatureOnly:
    def predict(self, features):
        # Source emits measurements. The session-local baseline model does the scoring.
        return {"valid": False, "attention_score": None, "model_type": "feature_only"}


class UnicornSource:
    def __init__(self, *, device_factory=None):
        self.stream_id = f"unicorn-{uuid4().hex}"
        self.device_factory = device_factory
        self.stop_event = Event()
        self.thread = None
        self.device_info = EegDeviceInfo(
            model="gtec_unicorn",
            confirmed=False,
            sample_rate_hz=None,
            channel_names=None,
            units=None,
        )

    def start(self, sink, clock):
        if self.thread is not None:
            return
        self.stop_event.clear()

        def status(state, flags):
            sink.publish_status(
                EegStatus(
                    stream_id=self.stream_id,
                    state=state,
                    flags=flags,
                    device=self.device_info,
                    dropped_packets=None,
                    t_backend_ms=clock.now_ms(),
                    provenance={
                        "run_kind": "live",
                        "producer": PRODUCER,
                        "producer_version": "0.1.0",
                    },
                )
            )

        def run():
            device = controller = None
            status("connecting", [])
            try:
                from eeg.acquisition.unicorn_device import UnicornEEGDevice
                from eeg.processing.signal_preprocessor import EEGPreprocessor
                from eeg.realtime.streaming_controller import StreamingController
                from evaluation.realtime_stream import WindowQuality

                device = EegChannels(
                    self.device_factory() if self.device_factory else UnicornEEGDevice()
                )
                device.connect()
                info = device.get_device_info()
                self.device_info = EegDeviceInfo(
                    model="gtec_unicorn",
                    confirmed=True,
                    sample_rate_hz=info["sampling_frequency_hz"],
                    channel_names=list(device.names),
                    units="uV",
                )
                tracker = WindowQuality(EEGPreprocessor(), warmup_s=10)
                controller = StreamingController(
                    device,
                    tracker,
                    SpectralExtractor(),
                    FeatureOnly(),
                    window_duration_seconds=2,
                    update_interval_seconds=0.5,
                    batch_size=5,
                    output_capacity=8,
                )
                controller.start()
                status("warming_up", ["settling"])
                while not self.stop_event.is_set():
                    if controller.error is not None:
                        raise RuntimeError(str(controller.error))
                    try:
                        frame = tracker.annotate(controller.get_frame(timeout=0.1))
                    except queue.Empty:
                        continue
                    first, last = frame["sample_indices"]
                    uncertainty = device.uncertainty(first, last)
                    now = clock.now_ms()
                    start_ms = frame["window_start_timestamp"] * 1000
                    end_ms = frame["window_end_timestamp"] * 1000
                    good = (
                        frame["evaluation_quality"]["usable"]
                        and all(f["valid"] for f in frame["features"].values())
                        and uncertainty is not None
                        and uncertainty <= 50
                        and 0 <= now - end_ms <= 2000
                    )
                    flags = (
                        []
                        if good
                        else ["settling"]
                        if not frame["evaluation_quality"]["warmup_complete"]
                        else ["clock_uncertain"]
                        if uncertainty is None or uncertainty > 50 or end_ms > now
                        else ["large_artifact"]
                    )
                    status(
                        "ok"
                        if good
                        else "warming_up"
                        if not frame["evaluation_quality"]["warmup_complete"]
                        else "degraded",
                        flags,
                    )
                    if end_ms > now:
                        continue
                    features = [
                        {
                            "name": f"log_relative_{band}",
                            "unit": "log_relative_power",
                            "channel": channel,
                            "value": frame["features"][f"{channel}:{band}"]["value"],
                            "missing_reason": None
                            if frame["features"][f"{channel}:{band}"]["valid"]
                            else "spectral feature unavailable",
                        }
                        for channel in device.names
                        for band, _, _ in BANDS
                    ]
                    sink.publish_window(
                        EegFeatureWindow(
                            window_id=f"{self.stream_id}-{frame['frame_index']}",
                            stream_id=self.stream_id,
                            feature_set_version=FEATURE_SET,
                            evidence={
                                "start_backend_ms": start_ms,
                                "end_backend_ms": end_ms,
                            },
                            device_evidence_start_device_s=frame[
                                "window_start_timestamp"
                            ],
                            device_evidence_end_device_s=frame["window_end_timestamp"],
                            clock_correction={
                                "method": "same_clock",
                                "offset_s": 0,
                                "drift_ppm": None,
                                "uncertainty_ms": uncertainty,
                            },
                            samples={
                                "expected": last - first + 1,
                                "received": last - first + 1,
                            },
                            channels=list(device.names),
                            features=features,
                            quality={
                                "usable": bool(good),
                                "flags": flags,
                                "channels": [
                                    {
                                        "channel": c,
                                        "state": "good" if good else "unknown",
                                        "flags": flags,
                                    }
                                    for c in device.names
                                ],
                            },
                            t_processed_backend_ms=now,
                            provenance={
                                "run_kind": "live",
                                "producer": PRODUCER,
                                "producer_version": "0.1.0",
                            },
                        )
                    )
            except Exception as error:
                logging.getLogger(__name__).warning(
                    "Unicorn source unavailable: %s", error
                )
                # Missing SDK/headset is visible as unavailable, never simulated EEG.
                status("unavailable", ["disconnected"])
            finally:
                if controller is not None:
                    try:
                        controller.stop()
                    except Exception:
                        pass
                if device is not None:
                    try:
                        device.disconnect()
                    except Exception:
                        pass

        self.thread = Thread(target=run, name="unicorn-live-source", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=5)
            self.thread = None


def make_source():
    return UnicornSource()
