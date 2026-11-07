# g.Pype evaluation (audit, 2026-11-07)

Source: https://gpype.gtec.at/ (docs v4.1.0, pages updated 2026-10-09/10), read for this audit. Nothing here was run against a device.

## What the docs say
- Python SDK (3.10-3.14; Windows x64, macOS Apple silicon, Linux x86_64) with real-time or offline pipelines: frames of about 16 ms, soft real time (no deadline guaranteed), filters, `BandPower`, FFT, epochs, LSL/UDP in and out, record/replay, optional PyQtGraph scopes. Code only, no designer GUI.
- Licence: source-available non-commercial (GNCL): free for private and educational use; commercial deployment needs a purchased runtime licence. No prices published. Using it as acquisition software for a non-g.tec amplifier is listed as prohibited.
- Devices: the site never uses the name "Unicorn BCI Core". It lists **BCI Core-4 / BCI Core-8 / gCore** (node `BCICore`, Bluetooth LE, driver `gtec-ble`, 250 Hz for Core-4/8, Linux x86_64 supported) and, separately, **Unicorn Hybrid Black** (`HybridBlack`, driver `gtec-unicorn`, needs a Unicorn Python Hybrid Black licence). Whether our headset is a "BCI Core-8" is not established by the docs.
- macOS: Bluetooth permission is required, and a script without a window (`app.run()`) receives nothing from the Unicorn driver family.

## Fit with this project
- We already have acquisition + preprocessing + a streaming controller in `eeg/` (@annieqqa) and an `EegSource` seam (`platform/.../eeg/interface.py`) that takes any producer. g.Pype would replace that stack, not plug into it; the only low-friction use is a `gp.Source`/LSL bridge or `BandPower` as a feature step inside Annie's pipeline.
- Hardware is unverified either way. Neither path has run against the headset in this repo.
- Two risks specific to g.Pype: soft real time with a pipeline that is stopped when it falls behind (our timing model needs honest gaps, which it supports), and the window-less macOS Bluetooth caveat for our headless backend process.

## Recommendation
**Do not adopt g.Pype for the hackathon deliverable.** Keep `eeg/` as the acquisition and preprocessing path. Reasons: it would be a rewrite of a teammate's area with no hardware evidence; the docs do not confirm support for our exact device name; the licence is fine for a student demo but blocks any later commercial use without a purchase; and our remaining risk is the unconfirmed score contract and untested hardware, not signal-processing tooling.

**Cheap follow-up (optional, after Annie confirms the exact model and that her driver works):** a one-hour spike reading `BCICore` through g.Pype into the existing `EegSource` as a second source, to compare against her pipeline. Do it only if her driver path is failing on the real headset.
