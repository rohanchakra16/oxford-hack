# Timing (Person 5)

Four clocks never mix without an explicit mapping:

| Name | Unit | Source |
|---|---|---|
| browser ms | ms | `performance.now()` in the page |
| backend ms | ms | monotonic clock of the backend process (since boot; small on a fresh machine) |
| device / LSL | s | EEG device or LSL clock, mapped to backend ms by `timing/device_clock.py` |
| media time | s | `<video>.currentTime` |

## Browser to backend

The backend pings, the browser answers (`clock_ping` / `clock_pong`). Per exchange, with t1 backend send, t2 browser
receive, t3 browser send, t4 backend receive: `offset = ((t2 - t1) + (t3 - t4)) / 2` (browser minus backend) and
`rtt = (t4 - t1) - (t3 - t2)`. The estimate uses the minimum-RTT recent sample; its uncertainty is `rtt/2` (worst-case
asymmetry) plus timer resolution plus drift since that sample. Implementation: `src/platform/src/oxford_hack/timing/clock_sync.py`.
Every mapped bookmark carries `mappingUncertaintyMs`; if the clock is unsynchronised or too uncertain the candidate is
rejected (`clock_unsynchronised`, `clock_uncertain`), never guessed.

## Backend to media

The browser reports `playback_state` (heartbeats and every transition). The backend keeps a history of *segments*:
stretches of uninterrupted playback at one rate, anchored at (browser ms, media s). Evidence (a backend-ms interval) is
mapped only if it lies inside **one** segment, away from its edges by `boundaryMarginMs`. It is rejected across a
pause, seek, buffering or rate change (`crosses_boundary`), when the telemetry is too old (`stale_telemetry`), or
outside the media (`out_of_media_bounds`). A tail not yet covered by telemetry stays pending for up to
`pendingTimeoutMs`. A heartbeat disagreeing with the segment's prediction by more than 0.5 s ends the segment.
Implementation: `timing/playback.py`.

Defaults (sent to the browser in `session_config.mapping`): lead-in 2 s, boundary margin 250 ms, max clock uncertainty
50 ms, max telemetry staleness 2.5 s, pending timeout 3 s, max candidate age 30 s.

## Missing data

An absent window, sensor or mapping is `null` plus a reason, never `0`. A detector declares `unknown`/`interrupted`
instead of publishing.

## Tests

`src/platform/tests/test_clock_sync.py`, `test_device_clock.py`, `test_playback.py`, `test_hub.py` (deterministic simulator),
and the browser tests in `src/frontend/e2e/` (see its README).
