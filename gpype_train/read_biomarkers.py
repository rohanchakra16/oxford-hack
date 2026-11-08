"""Measure theta, alpha, and beta biomarkers from Unicorn Recorder's live LSL output."""

import os
from pathlib import Path
from uuid import uuid4

import gpype as gp

FFT_WINDOW_SAMPLES = 250

FRONTAL_CHANNELS = [1]
CENTRAL_CHANNELS = [2, 3, 4]
POSTERIOR_CHANNELS = [5, 6, 7, 8]

STREAM_NAME = os.environ.get(
    "UNICORN_LSL_STREAM_NAME", "UnicornRecorderRawDataLSLStream"
)


def main() -> None:
    session_id = uuid4().hex
    output_dir = Path("recordings")
    output_dir.mkdir(exist_ok=True)

    print(f"Waiting for Unicorn Recorder LSL stream: {STREAM_NAME}")
    try:
        source = gp.LslReceiver(stream_name=STREAM_NAME)
    except RuntimeError as exc:
        raise SystemExit(
            f"{exc}\n"
            "Keep Unicorn Recorder open and acquiring. In Settings > Network "
            "settings, enable Raw Data LSL Output and set its stream name to "
            f"'{STREAM_NAME}'."
        ) from None

    app = gp.MainApp()
    pipeline = gp.Pipeline()

    eeg = gp.Router(input_channels=list(range(8)))
    pipeline.connect(source, eeg)

    frontal = gp.ChannelSelector(indices=FRONTAL_CHANNELS)
    frontal_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
    frontal_power = gp.BandPower(bands=["theta"])
    frontal_out = gp.Collector(name="frontal_theta")
    pipeline.connect(eeg, frontal)
    pipeline.connect(frontal, frontal_fft)
    pipeline.connect(frontal_fft, frontal_power)
    pipeline.connect(frontal_power, frontal_out)

    posterior = gp.ChannelSelector(indices=POSTERIOR_CHANNELS)
    posterior_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
    posterior_power = gp.BandPower(bands=["alpha"])
    posterior_out = gp.Collector(name="posterior_alpha")
    pipeline.connect(eeg, posterior)
    pipeline.connect(posterior, posterior_fft)
    pipeline.connect(posterior_fft, posterior_power)
    pipeline.connect(posterior_power, posterior_out)

    central = gp.ChannelSelector(indices=CENTRAL_CHANNELS)
    central_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
    central_power = gp.BandPower(bands=["beta"])
    central_out = gp.Collector(name="central_beta")
    pipeline.connect(eeg, central)
    pipeline.connect(central, central_fft)
    pipeline.connect(central_fft, central_power)
    pipeline.connect(central_power, central_out)

    combined = gp.Router(
        input_channels={
            "frontal": gp.Router.ALL,
            "posterior": gp.Router.ALL,
            "central": gp.Router.ALL,
        }
    )
    pipeline.connect(frontal_power, combined["frontal"])
    pipeline.connect(posterior_power, combined["posterior"])
    pipeline.connect(central_power, combined["central"])

    scope = gp.TimeSeriesScope(name="biomarkers")
    writer = gp.CsvWriter(
        file_name=str(output_dir / f"attention_biomarkers_{session_id}.csv")
    )
    pipeline.connect(combined, writer)
    pipeline.connect(combined, scope)
    app.add_widget(scope)

    try:
        pipeline.start()
    except (ConnectionError, RuntimeError) as exc:
        pipeline.close()
        raise SystemExit(
            f"{exc}\n"
            "Keep Unicorn Recorder acquiring with its LSL output enabled. "
            f"The configured stream name must be '{STREAM_NAME}'."
        ) from None

    try:
        app.run()
    finally:
        pipeline.stop()
        pipeline.close()


if __name__ == "__main__":
    main()