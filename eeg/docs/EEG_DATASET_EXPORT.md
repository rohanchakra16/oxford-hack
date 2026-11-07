# EEG dataset loading and export

`DatasetExporter` writes raw recordings from `RecordingDatabase` without
filtering, feature extraction, or assumptions about attention biomarkers.

## Formats

- **NPZ** contains samples, timestamps, global sample indices, channel names,
  sampling frequency, signal units, and JSON-encoded recording metadata and
  annotations. It is the lossless round-trip format.
- **CSV** contains `timestamp`, `sample_index`, and one column per channel.
  Exporting CSV also writes a same-name `.json` sidecar containing labels,
  annotations, channel metadata, and sampling information.
- **JSON** contains recording metadata and annotations only. It is useful for
  catalogues and interchange, but does not contain EEG arrays.

`DatasetLoader` validates required fields, array dimensions, channel order,
sample counts, UUIDs, and metadata consistency. Missing, corrupted, or
inconsistent files raise `DatasetLoadError`; no partial recording is returned.

The exporter supports one recording, all recordings, exact label matches, and
explicit recording-ID selections. Export preserves the original raw data and
does not calculate EEG features.
