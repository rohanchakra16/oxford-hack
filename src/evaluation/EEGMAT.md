# Public EEG bootstrap: workload proxy 0.1.0

We trained a real EEG model while local attention-labelled recordings are being
collected. It predicts **mental arithmetic versus rest**, not lecture attention,
distraction, understanding, or a measured lapse. The numeric output is an
uncalibrated source-task probability, not an attention percentage. It produces
no review candidates and declares no evaluated live modes.

## Dataset and selection

[EEGMAT 1.0.0](https://physionet.org/content/eegmat/1.0.0/),
[DOI 10.13026/C2JQ1P](https://doi.org/10.13026/C2JQ1P), is openly downloadable
under ODC-By-1.0. Its two conditions are background EEG (`_1`) and mental
arithmetic (`_2`). We use all 36 participants and 72 EDF recordings. We do not
use the demographic or count-quality table as features or attention labels.
Original source recordings already underwent artifact treatment; this matters
when considering transfer to a noisy wearable.

Credit: Zyma and colleagues (2019),
[Electroencephalograms during Mental Arithmetic Task Performance](https://doi.org/10.3390/data4010014),
Data 4(1), 14. PhysioNet reference: Pollard et al. (2026),
[PhysioNet as a global platform for biomedical research](https://doi.org/10.1038/s44360-026-00096-z).

The downloader pins the upstream checksum-manifest SHA-256 and verifies every
recording. Raw EDFs remain under ignored `src/inference/.local/eegmat/`; they are
not committed. The committed model contains learned coefficients; the report
contains checksums, splits and aggregate/per-participant metrics, not waveforms.

[MEMA](https://github.com/GuanjianLiu/MEMA) has more closely aligned attention
task labels, but the author's repository links to Baidu storage and does not
state a clear dataset licence. It was inspected but not downloaded or used.
The [MEMA paper](https://arxiv.org/abs/2411.09879) is a future data-source lead.

## Compatibility with Annie's work

| Item | EEGMAT | Annie's `feature/EEG-input` at `f20ee35` |
| --- | --- | --- |
| Recording format | EDF | NPZ, or CSV plus JSON sidecar |
| Model labels | Rest / mental arithmetic | Configurable collection labels, including Focused / Distracted / Relaxed / Drowsy |
| Common in-memory boundary | Converted to `SampleBatch` | `SampleBatch`: samples by channels, uV, timestamps and sample indices |
| Preprocessing | Runs Annie's existing implementation | Stateful `EEGPreprocessor`, with quality metadata |
| Attention estimates | No supplied attention truth | Named attention features are currently explicit unavailable stubs |

`src/inference/annie_bridge.py` imports her unchanged `SampleBatch` and
`EEGPreprocessor` from a pinned read-only source snapshot. It verifies hashes
of the two source files, normalising line endings. Each recording is processed
in consecutive one-second batches with retained causal filter/DC state. No EEG
filter or stub is replaced. `src/inference/workload_cli.py` also uses her actual
`DatasetLoader` for NPZ/CSV input; an export/load/scoring compatibility test
runs against those classes.

The model selects **named Fz, Cz and Pz** channels; it does not assume that
the first three Unicorn channels have those locations. EEGMAT's 500 Hz signals
are converted offline to 250 Hz with polyphase resampling. Local recordings
must have confirmed uV units, named electrodes, 250 Hz rate, and continuous
indices/timestamps. Missing metadata/required channels, gaps or unusable
quality produce unknown with no score. Physical-device metadata and sensor-side
integration remain Annie's handoff; none of her files was edited.

## Fixed experiment and held-out results

Seed 17 assigns 22 training, seven validation, and seven test participants
before windowing. All recordings from a participant stay together. Each
condition uses its first 60 s, discards the first 10 s of filter startup,
then uses twelve non-overlapping 4 s windows (48 s scored per recording).
There are 864 windows and zero quality exclusions in this run.

Annie's DC removal and 1–40 Hz causal bandpass run continuously within each
recording; no extra notch is applied. The model transform uses Welch PSD with
2 s Hann segments and 1 s overlap, taking log relative power in half-open
theta [4,8), alpha [8,13), and beta [13,30) Hz bands, relative to [1,30) Hz,
separately for each of the three channels. These are nine model inputs, not
validated biomarkers or replacements for the EEG owner's feature functions.

StandardScaler is fit on training windows only. Balanced logistic regression
tries C in 0.01, 0.1, 1 and 10, selecting the mean participant balanced accuracy
on validation data; ties prefer smaller C. Threshold 0.5 stays fixed. C=0.01
was selected. The JSON model was frozen before test inference, with no final
refit on validation/test data. Its predictions match sklearn within 1e-12.

| Split | Participants | Windows | Balanced accuracy | ROC-AUC |
| --- | ---: | ---: | ---: | ---: |
| Train | 22 | 528 | 0.6061 | 0.6472 |
| Validation | 7 | 168 | 0.6071 | 0.7154 |
| Test | 7 | 168 | **0.7143** | **0.7313** |

The test confusion matrix, rows/columns rest then arithmetic, is
`[[60,24],[24,60]]`. A constant classifier has balanced accuracy 0.5.
The participant-bootstrap 95% interval for mean balanced accuracy is
0.6310–0.7857 (2,000 resamples, seed 17). This small, seven-participant
estimate does not establish generalisation to our users or hardware.

The complete report, validation selection table, software versions, public
recording hashes, participant assignments and bundle hash are in
[`fixtures/eegmat-report.json`](fixtures/eegmat-report.json). Model:
[`src/inference/bundles/eegmat-workload-0.1.0.json`](../inference/bundles/eegmat-workload-0.1.0.json).

## Reproduce and score

Use the Python environment and `PYTHONPATH` setup in `src/inference/README.md`.
Install the optional packages in `src/inference/requirements-public-eeg.txt` into
that environment (numpy 2.3.5, scipy 1.16.3, sklearn 1.7.2, MNE 1.11.0).
The run was verified on Windows with Python 3.13.18.

The EEG source has not yet merged into main. Fetch it without checking out or
editing the owner's files, then create an ignored snapshot (PowerShell):

```powershell
git fetch origin feature/EEG-input
New-Item -ItemType Directory -Force src/inference/.local/annie-f20ee35 | Out-Null
git archive --format=tar --output=src/inference/.local/annie-source.tar f20ee35c06b89ec6499bd45d79a8b67296fbabbc eeg
tar -xf src/inference/.local/annie-source.tar -C src/inference/.local/annie-f20ee35
$env:PYTHONPATH = "$PWD/src;$PWD/src/platform/src"
src/inference/.venv/Scripts/python.exe -m evaluation.eegmat_data
src/inference/.venv/Scripts/python.exe -m evaluation.eegmat --eeg-source src/inference/.local/annie-f20ee35 --output src/inference/.local/eegmat-run
src/inference/.venv/Scripts/python.exe -m inference.workload_cli --eeg-source src/inference/.local/annie-f20ee35 --eegmat-file src/inference/.local/eegmat/Subject00_2.edf
src/inference/.venv/Scripts/python.exe -m pytest src/inference/tests src/evaluation/tests -q
```

For an authorised local export, use `--recording data/example.npz` instead of
`--eegmat-file`. NPZ and CSV/JSON are loaded by Annie's `DatasetLoader` with
pickle disabled. Device-clock seconds stay explicit in output; this scorer
does not map them to backend/media time. `score_batch` processes whole offline
recordings; the existing live inference adapter is unchanged.

Tests with scientific packages installed: 48 passed, including train-only
normalisation, source/export compatibility, invalid input and artifact/source
hash checks. Current core CI can run the portable model tests without these
optional packages (verified separately: 40 passed, one module skipped); the
scientific test module skips when dependencies are absent, and the source
compatibility tests skip without the pinned EEG snapshot.

## Limits and next work

Task-state labels cannot supply lecture-lapse event truth, so event metrics
are explicitly unavailable. Gaze-only and combined learned models are also
unevaluated: this dataset has no synchronised gaze. Scores are uncalibrated.
The upstream reference, filtering/ICA, acquisition device, session protocol
and offline resampler differ from our wearable deployment. Relative spectral
power reduces gain dependence but does not establish device invariance.

Next, confirm electrode mapping and quality semantics with Annie, collect local
Focused/Distracted/unknown/interrupted recordings under the collection protocol,
and reserve unseen participants/sessions for local validation. Do not relabel
rest as distracted or arithmetic as focused to manufacture local ground truth.
Any sensor, platform or UI changes require their owner's explicit handoff.
