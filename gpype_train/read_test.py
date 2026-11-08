"""Filter, display, and save Unicorn Recorder's live LSL output.

Keep Recorder acquiring and enable Raw Data LSL Output in its Network settings.
Use UNICORN_LSL_STREAM_NAME if the configured stream name differs below.
"""

import os

import gpype as gp

STREAM_NAME = os.environ.get(
    "UNICORN_LSL_STREAM_NAME", "UnicornRecorderRawDataLSLStream"
)


def main():
    # Recorder owns Bluetooth; Python receives the stream it publishes.
    # Resolve the actual channel count and sampling rate from its LSL metadata.
    print(f"Waiting for Unicorn Recorder LSL stream: {STREAM_NAME}")
    try:
        source = gp.LslReceiver(stream_name=STREAM_NAME)
    except RuntimeError as exc:
        raise SystemExit(
            f"{exc}\n"
            "Keep Unicorn Recorder open and acquiring. In Settings > Network "
            "settings, enable Raw Data LSL Output and set its stream name to "
            f"'{STREAM_NAME}'. If your Recorder only has a single LSL output, "
            "enable it and set UNICORN_LSL_STREAM_NAME to that output's name."
        ) from None

    app = gp.MainApp()
    p = gp.Pipeline()
    # Recorder publishes its eight EEG channels first, followed by any extras.
    # Keep trigger/status and other auxiliary values out of the EEG filter/CSV.
    eeg = gp.Router(input_channels=list(range(8)))
    lowpass = gp.Lowpass(f_c=6)
    scope = gp.TimeSeriesScope()
    collected = gp.Collector(name="filtered")
    writer = gp.CsvWriter(file_name="filtered.csv")

    p.connect(source, eeg)
    p.connect(eeg, lowpass)
    p.connect(lowpass, writer)
    p.connect(lowpass, scope)
    p.connect(lowpass, collected)
    app.add_widget(scope)

    try:
        p.start()
    except (ConnectionError, RuntimeError) as exc:
        p.close()
        raise SystemExit(
            f"{exc}\n"
            "Keep Unicorn Recorder acquiring with its LSL output enabled. "
            f"The configured stream name must be '{STREAM_NAME}'."
        ) from None

    try:
        app.run()  # blocking until window is closed
    finally:
        p.stop()
        p.close()

    result = collected.result
    if result is None:
        raise RuntimeError("The pipeline produced no filtered data")
    print(f"Captured data shape (time, channels): {result.data.shape}")
    print(f"Sampling rate: {result.rate} Hz")


if __name__ == "__main__":
    main()
