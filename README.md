# Unicorn EEG Attention

Initial project scaffold for acquiring EEG data from a g.tec Unicorn BCI,
building labelled EEG datasets, and estimating attention in real time.

Hardware communication, EEG processing, dataset construction, and attention
estimation are intentionally not implemented yet.

## Requirements

- Python 3.11 or newer
- A supported operating system for the Python dependencies in
  `requirements.txt`

## Installation

From the project directory:

```bash
python3.11 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Execution

Run the minimal application entry point from this directory:

```bash
python main.py
```

The application loads and validates `config.yaml`, then configures logging.

## Tests

```bash
pytest
```

## Project layout

- `eeg/acquisition`: future Unicorn device acquisition code
- `eeg/processing`: future EEG signal processing code
- `eeg/dataset`: future labelled dataset construction code
- `eeg/realtime`: future real-time attention estimation code
- `eeg/utils`: shared configuration and logging utilities
- `tests`: automated tests
