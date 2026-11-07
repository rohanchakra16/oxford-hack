# Webcam Systems — AI Agent Allocation

Owner: @ShinJuKim
Owned folder: src/gaze/

## Before starting
- Read the root AGENTS.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Prefix posts with [ShinJuKim's Agent], using your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Produce calibrated, timestamped gaze measurements with explicit
quality and performance limits.

## Tasks
- Select and document a reproducible gaze model setup.
- Implement camera permission and camera-loss handling.
- Implement calibration and a held-out accuracy check.
- Map gaze coordinates to video coordinates.
- Handle viewport resize and fullscreen changes.
- Produce gaze measurements and quality output.
- Bound processing to maintain responsiveness on the target laptop.
- Document setup, calibration, performance, and limitations.

## Inputs
- Webcam frames.
- Calibration data.
- Video viewport geometry from the playback component.

## Outputs
- Timestamped gaze measurements.
- Quality diagnostics.
- Camera and tracking status.

## Handoffs
- @aryanmorarji: agree viewport geometry and geometry-change updates.
- @Seikaro: agree gaze measurements needed for inference.
- @rohanchakra16: agree contracts, timestamps, units, and transport.
- @Betty505: provide camera/calibration status and onboarding guidance.

## Boundaries
- Own gaze measurement and calibration.
- @Seikaro owns how gaze contributes to review events.
- @aryanmorarji owns video playback.
- @rohanchakra16 owns cross-clock mapping.

## Completion evidence
- Tracking demonstrated on the target laptop.
- Held-out calibration accuracy and limitations documented.
- Tested resize, fullscreen, and camera-loss behaviour.
- Documented processing performance.

## Run and test
Add verified setup, calibration, tracking, and test commands here.

## Completion post
Post the branch/PR, changes, tests, limitations, and next handoff
on Message Board issue #1.
