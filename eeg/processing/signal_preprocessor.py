"""Stateful EEG signal preprocessing and basic quality assessment.

This module operates on acquisition batches rather than analysis windows.
Filter states are carried from one call to the next, which makes separate
calls equivalent to processing one continuous stream. It intentionally does
not perform feature extraction, attention estimation, artifact correction, or
channel selection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import signal

from eeg.acquisition.base_device import SampleBatch


@dataclass(frozen=True)
class PreprocessedBatch:
    """Processed samples with original timing and quality metadata.

    ``samples`` has the same row and channel ordering as the input batch.
    ``timestamps`` and ``sample_indices`` are copied unchanged so downstream
    code can align processed values with acquisition events. ``quality`` is a
    dictionary of basic checks for this batch, not a clinical interpretation.
    """

    samples: np.ndarray
    timestamps: np.ndarray
    sample_indices: np.ndarray
    quality: dict[str, Any]


class EEGPreprocessor:
    """Configurable stateful preprocessing for a continuous EEG stream.

    Processing order is: replace non-finite values for safe numerical
    filtering, remove the slowly tracked DC component, apply the optional
    Butterworth bandpass, apply the optional notch filter, then calculate
    quality indicators. Configure an operation as ``None`` or ``False`` to
    disable it. A preprocessor should be reset before starting a new unrelated
    stream.
    """

    def __init__(
        self,
        *,
        remove_dc_offset: bool = True,
        bandpass: tuple[float, float] | None = (1.0, 40.0),
        notch_frequency_hz: float | None = None,
        quality_max_amplitude: float | None = 500.0,
        quality_flatline_tolerance: float = 1e-12,
    ) -> None:
        """Create a preprocessor with independent filtering and quality options.

        Args:
            remove_dc_offset: Track and subtract a slowly changing channel
                baseline.
            bandpass: Inclusive frequency limits in Hz, or ``None`` to skip
                bandpass filtering. The default is 1-40 Hz.
            notch_frequency_hz: Mains frequency, normally 50 or 60 Hz, or
                ``None`` to skip notch filtering.
            quality_max_amplitude: Absolute amplitude threshold in the input
                signal units, or ``None`` to disable that check.
            quality_flatline_tolerance: Peak-to-peak threshold used to flag a
                channel as flatline.
        """
        self.remove_dc_offset = remove_dc_offset
        self.bandpass = bandpass
        self.notch_frequency_hz = notch_frequency_hz
        self.quality_max_amplitude = quality_max_amplitude
        self.quality_flatline_tolerance = quality_flatline_tolerance
        self._sampling_frequency_hz: float | None = None
        self._bandpass_sos: np.ndarray | None = None
        self._bandpass_state: np.ndarray | None = None
        self._notch_b: np.ndarray | None = None
        self._notch_a: np.ndarray | None = None
        self._notch_state: np.ndarray | None = None
        self._dc_state: np.ndarray | None = None
        self._last_index: int | None = None

    def process(self, sample_batch: SampleBatch) -> PreprocessedBatch:
        """Process one batch while retaining state across consecutive batches.

        Missing samples are inferred from the global sample indices. Non-finite
        values are counted and replaced with zero before filtering so a single
        invalid value cannot contaminate the filter state with NaNs. The
        original timestamps and indices are always returned unchanged.
        """
        self._configure(sample_batch)
        samples = np.asarray(sample_batch.samples, dtype=np.float64).copy()
        non_finite = ~np.isfinite(samples)
        missing_count = 0
        if self._last_index is not None:
            missing_count = max(0, int(sample_batch.sample_indices[0] - self._last_index - 1))
        self._last_index = int(sample_batch.sample_indices[-1])
        samples[non_finite] = 0.0

        if self.remove_dc_offset:
            assert self._dc_state is not None
            for row in samples:
                self._dc_state += (row - self._dc_state) / (
                    10.0 * sample_batch.sampling_frequency_hz
                )
                row -= self._dc_state
        if self._bandpass_sos is not None:
            assert self._bandpass_state is not None
            samples, self._bandpass_state = signal.sosfilt(
                self._bandpass_sos, samples, axis=0, zi=self._bandpass_state
            )
        if self._notch_b is not None:
            assert self._notch_a is not None and self._notch_state is not None
            samples, self._notch_state = signal.lfilter(
                self._notch_b, self._notch_a, samples, axis=0, zi=self._notch_state
            )

        quality = self._quality(samples, non_finite, missing_count)
        return PreprocessedBatch(
            samples=samples,
            timestamps=sample_batch.timestamps.copy(),
            sample_indices=sample_batch.sample_indices.copy(),
            quality=quality,
        )

    def reset(self) -> None:
        """Clear filter and continuity state before a new acquisition stream."""
        self._sampling_frequency_hz = None
        self._bandpass_sos = self._bandpass_state = None
        self._notch_b = self._notch_a = self._notch_state = None
        self._dc_state = None
        self._last_index = None

    def _configure(self, batch: SampleBatch) -> None:
        """Build filters for the batch rate while preserving compatible state."""
        fs = batch.sampling_frequency_hz
        channels = batch.samples.shape[1]
        if self._sampling_frequency_hz == fs and self._dc_state is not None:
            if self._dc_state.shape[0] != channels:
                raise ValueError("Channel count changed during preprocessing")
            return
        if self.bandpass is not None:
            low, high = self.bandpass
            if not 0 < low < high < fs / 2:
                raise ValueError("bandpass must satisfy 0 < low < high < Nyquist")
            self._bandpass_sos = signal.butter(4, (low, high), btype="bandpass", fs=fs, output="sos")
            self._bandpass_state = np.zeros((self._bandpass_sos.shape[0], 2, channels))
        if self.notch_frequency_hz is not None:
            if not 0 < self.notch_frequency_hz < fs / 2:
                raise ValueError("notch frequency must be below Nyquist")
            self._notch_b, self._notch_a = signal.iirnotch(
                self.notch_frequency_hz, 30.0, fs=fs
            )
            self._notch_state = np.zeros((2, channels))
        self._dc_state = np.zeros(channels)
        self._sampling_frequency_hz = fs

    def _quality(
        self, samples: np.ndarray, non_finite: np.ndarray, missing_count: int
    ) -> dict[str, Any]:
        """Calculate configurable basic indicators for each channel."""
        flatline = np.ptp(samples, axis=0) <= self.quality_flatline_tolerance
        excessive = (
            np.max(np.abs(samples), axis=0) > self.quality_max_amplitude
            if self.quality_max_amplitude is not None
            else np.zeros(samples.shape[1], dtype=bool)
        )
        non_finite_count = int(np.count_nonzero(non_finite))
        flags = tuple(
            {
                "non_finite": bool(np.any(non_finite[:, channel])),
                "flatline": bool(flatline[channel]),
                "excessive_amplitude": bool(excessive[channel]),
            }
            for channel in range(samples.shape[1])
        )
        return {
            "missing_sample_count": missing_count,
            "non_finite_sample_count": non_finite_count,
            "flatline_channels": tuple(np.flatnonzero(flatline).tolist()),
            "excessive_amplitude_channels": tuple(np.flatnonzero(excessive).tolist()),
            "channel_flags": flags,
            "note": "Basic quality checks only; not complete physiological artefact removal.",
        }
