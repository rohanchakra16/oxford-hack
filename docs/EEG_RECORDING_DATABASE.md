# EEG recording database

The dataset layer stores raw EEG safely and keeps searchable metadata separate
from large numeric arrays.

## Storage model

SQLite contains two tables:

### `recordings`

| Column | Meaning |
|---|---|
| `recording_id` | UUID primary key |
| `label` | Recording-level label |
| `start_timestamp`, `end_timestamp` | Acquisition time values |
| `duration_seconds` | Recording duration |
| `sampling_rate` | Samples per second |
| `channel_count` | Number of sample columns |
| `channel_names` | JSON array preserving channel order |
| `device_name`, `device_serial` | Acquisition device identity |
| `data_file_path` | Reference to the raw compressed NPZ |
| `sample_count` | Number of rows |
| `created_at` | UTC creation timestamp |

### `recording_annotations`

Annotations have their own UUID and reference a recording through
`recording_id`. `start_sample` and `end_sample` are global sample indices, not
array offsets or timestamps. `notes` stores free-form context.

## NPZ contents

Each recording is stored in a compressed NPZ file containing:

- `samples`
- `timestamps`
- `sample_indices`
- `channel_names`
- `sampling_frequency_hz`
- `signal_units`

The original acquired samples are always stored. The database never replaces
them with filtered or otherwise preprocessed data. If processed data is added
in the future, it must be written to a separate explicitly named file and
schema field.

## Consistency and failure behavior

Creation writes an NPZ to a temporary file in the destination directory,
flushes it, and atomically renames it. Only after that succeeds is the SQLite
row inserted. If the insert fails, the NPZ is removed.

All SQL values use parameterized queries. Reads validate the NPZ against the
`SampleBatch` contract. Deletion removes annotations and the recording row,
then removes its NPZ file. Database and filesystem failures are raised rather
than converted to success-shaped results.
