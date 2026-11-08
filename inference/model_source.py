"""Adapter for Annie's registered features and declared, implemented classifier.

REMIND_MODEL_FACTORY=module:factory supplies ModelPipeline. No default model,
feature formula, stub or spectral similarity is substituted for model output.
"""

import importlib
import math
import os
import hashlib
import json
from dataclasses import dataclass

from .unicorn_source import UnicornSource


@dataclass
class ModelPipeline:
    registry: object
    classifier: object
    model_id: str
    version: str
    score_min: float
    score_max: float
    higher_is_attentive: bool
    minimum_confidence: float = 0.6

    def __post_init__(self):
        if (
            not self.model_id
            or not self.version
            or not math.isfinite(self.score_min)
            or not math.isfinite(self.score_max)
            or self.score_max <= self.score_min
        ):
            raise ValueError("Model identity and explicit finite score range required")
        if (
            type(self.higher_is_attentive) is not bool
            or not 0 <= self.minimum_confidence <= 1
        ):
            raise ValueError("Model direction and confidence bounds required")


class RegistryModelExtractor:
    def __init__(self, pipeline):
        from eeg.realtime.feature_extractor import EEGFeatureExtractor
        from eeg.realtime.attention_classifier import StubAttentionClassifier

        if isinstance(pipeline.classifier, StubAttentionClassifier):
            raise ValueError("Annie's implemented classifier required; stub rejected")
        self.pipeline = pipeline
        self.features = EEGFeatureExtractor(pipeline.registry)

    def extract(self, *args, **kwargs):
        frame = self.features.extract(*args, **kwargs)
        result = self.pipeline.classifier.predict(frame)
        raw, confidence = result.get("attention_score"), result.get("confidence")
        valid = result.get("valid") is True and result.get("model_type") != "stub"
        valid = (
            valid
            and isinstance(raw, (int, float))
            and not isinstance(raw, bool)
            and math.isfinite(raw)
        )
        if confidence is not None:
            valid = (
                valid
                and isinstance(confidence, (int, float))
                and not isinstance(confidence, bool)
                and math.isfinite(confidence)
                and self.pipeline.minimum_confidence <= confidence <= 1
            )
        valid = (
            valid and self.pipeline.score_min <= raw <= self.pipeline.score_max
            if valid
            else False
        )
        value = (
            (raw - self.pipeline.score_min)
            / (self.pipeline.score_max - self.pipeline.score_min)
            if valid
            else None
        )
        if value is not None and not self.pipeline.higher_is_attentive:
            value = 1 - value
        # Keep named registry values in the extraction frame for analysis; predictions
        # are separate and do not pretend missing biomarkers are zero.
        frame["model_features"] = frame["features"]
        frame["features"] = {
            "attention_score": {
                "value": value * 100 if value is not None else None,
                "valid": valid,
            },
            "raw_model_output": {"value": raw if valid else None, "valid": valid},
        }
        for name, item in frame["model_features"].items():
            value = item["value"]
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                frame["features"][f"registry.{name}"] = item
        if confidence is not None:
            frame["features"]["model_confidence"] = {
                "value": confidence if valid else None,
                "valid": valid,
            }
        return frame


class ModelSource(UnicornSource):
    feature_set = "lecture-attention-0.1.0"
    producer = "lecture-attention-model"

    def __init__(self, pipeline):
        super().__init__()
        self.pipeline = pipeline
        configuration = [
            pipeline.score_min,
            pipeline.score_max,
            pipeline.higher_is_attentive,
            pipeline.minimum_confidence,
            [
                (n, pipeline.registry.get(n).config)
                for n in pipeline.registry.list_features()
            ],
        ]
        digest = hashlib.sha256(
            json.dumps(configuration, sort_keys=True).encode()
        ).hexdigest()[:12]
        self.model_version = f"{pipeline.model_id}:{pipeline.version}:{digest}"

    def extractor(self):
        return RegistryModelExtractor(self.pipeline)

    def encode_features(self, frame):
        return [
            {
                "name": name,
                "unit": "score_0_100"
                if name == "attention_score"
                else "fraction_0_1"
                if name == "model_confidence"
                else "model_native",
                "channel": None,
                "value": item["value"] if item["valid"] else None,
                "missing_reason": None if item["valid"] else "Model output unavailable",
            }
            for name, item in frame["features"].items()
        ]


class UnavailableModelSource:
    def __init__(self, reason):
        self.reason = reason

    def start(self, sink, clock):
        from oxford_hack.contracts.payloads import EegStatus

        sink.publish_status(
            EegStatus(
                stream_id="model-unavailable",
                state="unavailable",
                flags=["disconnected"],
                device={
                    "model": "gtec_unicorn",
                    "confirmed": False,
                    "sample_rate_hz": None,
                    "channel_names": None,
                    "units": None,
                },
                dropped_packets=None,
                t_backend_ms=clock.now_ms(),
                provenance={
                    "run_kind": "live",
                    "producer": "lecture-attention-model",
                    "producer_version": "unavailable",
                },
            )
        )
        import logging

        logging.getLogger(__name__).warning(self.reason)

    def stop(self):
        pass


def make_model_source():
    factory = os.environ.get("REMIND_MODEL_FACTORY")
    if not factory:
        return UnavailableModelSource(
            "Annie's model unavailable: set REMIND_MODEL_FACTORY=module:factory to an implemented ModelPipeline; no heuristic fallback"
        )
    try:
        module, name = factory.split(":")
        pipeline = getattr(importlib.import_module(module), name)()
        if not isinstance(pipeline, ModelPipeline):
            raise ValueError("Factory must return ModelPipeline")
        RegistryModelExtractor(pipeline)
        return ModelSource(pipeline)
    except (ImportError, AttributeError, ValueError, TypeError) as error:
        return UnavailableModelSource(f"Annie's model unavailable: {error}")
