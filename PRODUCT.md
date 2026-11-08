# Product

> Written by Impeccable's `init` flow. **Inferred from the team lead's written brief, not from an interview.** No
> interactive answer was collected in this session; every fact below comes from the brief or the repository and
> can be corrected.

## Platform
web (React 19, Vite). Desktop and laptop first, usable at 320 px. Local only: the video never leaves the browser.

## Users and job
A student watching a recorded lecture alone on a laptop. They lose the thread, want to mark a moment or be
reminded of one, then replay that passage in context (transcript, sentence-aligned) without leaving the lecture.

## What it makes possible
- Open a local lecture video and, optionally, a transcript (`.vtt`).
- Mark moments, or receive experimental suggestions from EEG and webcam gaze. Replay, dismiss, give feedback.
- See a timeline of review moments (attention graph) when a real score exists.

## Constraints (must be preserved)
- One player instance, one telemetry path. Replay behaviour and valid-range handling stay as they are.
- EEG and gaze signals are experimental, not validated attention measurements. Labels must stay accurate:
  "Test EEG + real webcam" when the EEG is scripted; gaze calibration is gaze calibration, not EEG calibration.
- Never fabricate a score curve. With no score stream the graph shows real markers and "Live score unavailable".
- Live and synthetic modes stay separate; there is no automatic mock fallback in physical mode.
- Camera frames and EEG samples are never stored. Calibration is browser-local.
- Nothing pauses or rewinds by itself. Suggestions are for review, not judgments about the student.

## Voice
Short, plain, calm. Controls name their action. Errors name the problem and the way out.

## Not decided here
Visual direction is set by the lead's brief (cool silver surfaces, graphite text, one restrained accent, a dark
video stage, selective Liquid Glass-style floating controls). See `DESIGN.md` once written.
