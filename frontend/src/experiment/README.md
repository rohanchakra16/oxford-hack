# Experimental CSV replay (#69)

Open **Session setup → Calibration → Experimental mode · testing only**, enable
the checkbox and import a CSV. Open a lecture and play it. Closing setup leaves
the experiment running. Disabling the checkbox stops its timers and restores the
normal attention graph. Mode choice and CSV contents are never persisted.
The included `example.csv` produces a test dip from five to eighteen seconds.

Input stays in the browser; parsing runs in a worker (20 MB limit). Supported:

- `time_s,attention_score`: declared 0–100 attention scores. `attention`/`score`
  aliases work. Without time, each row represents one second.
- Raw channels, including Annie's `timestamp,sample_index,Fz,Cz,Pz` export.
  Seconds are inferred from timestamps (relative or epoch), or use `time_ms` /
  `timestamp_ms`. Without time, set the sampling rate before importing (250 Hz
  default). Raw EEG needs 64–1000 Hz, two seconds and at least one non-flat channel.

Raw data uses a Hann-windowed FFT on two-second windows and the **test-only**
proxy `100 × beta(13–30 Hz) / (theta(4–8 Hz) + beta)`, averaged across channels.
It does not invoke or replace the production attention classifier. Missing,
flat and discontinuous windows stay unavailable. CSV end does not loop; seeking
the video back replays the corresponding samples. Time zero aligns with lecture
zero; no wall-clock timestamp is treated as a lecture position.

Mock normalized gaze coordinates are regenerated every ten wall-clock seconds
while the mode has a CSV and lecture, including while video is paused. The center
70% rectangle is the mock video area. No webcam is started. Test fusion is
`0.8 × EEG + 20` on-video, or `0.8 × EEG` away. Scores <=40 for eight continuous
playing seconds add a simulated graph dot, with a thirty-media-second cooldown.
Pause, buffering, seeking, invalid data and jumps interrupt dwell.

The existing graph/summary/seek UI reads a separate `AttentionTimelineStore`
with persistence disabled. Production attention polling stops during this mode;
live history and calibration profiles are untouched. Test dots remain local and
never enter backend bookmark/feedback contracts.
