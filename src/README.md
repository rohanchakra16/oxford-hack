# Application and shared source

These folders remain siblings so existing imports, fixture generators and
frontend/backend integration paths continue to work.

| Folder | Responsibility | Owner |
| --- | --- | --- |
| [contracts/](contracts/) | Generated message schemas and synthetic fixtures | @rohanchakra16 |
| [eeg/](eeg/) | EEG acquisition and features | @annieqqa |
| [evaluation/](evaluation/) | Labels, leakage-safe splits and event metrics | @Seikaro |
| [frontend/](frontend/) | Player, transcript, review UI and browser integration | @aryanmorarji / @Betty505 / @rohanchakra16, by area |
| [gaze/](gaze/) | Webcam gaze and calibration | @ShinJuKim |
| [inference/](inference/) | Signal combination and review candidate generation | @Seikaro |
| [integration/](integration/) | Combined development launcher | @rohanchakra16 |
| [platform/](platform/) | Local service, clocks, transport and replay harness | @rohanchakra16 |

The detailed allocation is in [AGENTS.md](../AGENTS.md). Some workstreams have
additional implementation on their owners' active branches; this directory
contains what has landed on `main`.

Internal generator paths and generated provenance banners such as
`contracts/schema/...` and `platform/src/...` are relative to this source tree.
Repository-level commands include the `src/` prefix; see the
[root README](../README.md) and [layout migration guide](../docs/REPOSITORY-LAYOUT.md).
