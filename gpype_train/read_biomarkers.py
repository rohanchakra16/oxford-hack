"""Measure 4–8 Hz theta-band power from the Fz electrode of a Unicorn BCI Core-8."""

import time  # Provides sleep(), which keeps this example running while acquisition happens.

import numpy as np  # Provides array operations for summarising the collected theta-power values.
import gpype as gp  # Imports g.Pype's public pipeline, source, filter, spectral, and sink nodes.
from pathlib import Path
from uuid import uuid4

session_id = uuid4().hex
output_dir = Path("recordings")
output_dir.mkdir(exist_ok=True)

# CONFIG

SAMPLING_RATE = 250  # Sets the expected Unicorn BCI Core-8 sampling rate in samples per second.
MEASUREMENT_SECONDS = 30  # Sets how long the live measurement will run before stopping.
LOW_CUTOFF_HZ = 1.0  # Removes DC offset and very slow baseline drift below 1 Hz.
HIGH_CUTOFF_HZ = 40.0  # Removes frequencies above 40 Hz, reducing high-frequency noise and muscle contamination.
THETA_LOW_HZ = 4.0  # Defines the lower edge of the theta band.
THETA_HIGH_HZ = 8.0  # Defines the upper edge of the theta band.
FFT_WINDOW_SAMPLES = 250  # Uses a 1-second FFT window because 250 samples / 250 Hz = 2 seconds.

# ATTENTION BIOMARKERS

attention_biomarkers = [
    "frontal_theta",
    "posterior_alpha",
    "central_beta"
]

FRONTAL_CHANNELS = ["ch01"]

CENTRAL_CHANNELS = [
    "ch02",
    "ch03",
    "ch04",
]

POSTERIOR_CHANNELS = [
    "ch05",
    "ch06",
    "ch07",
    "ch08",
]

# create main app
app = gp.MainApp()
pipeline = gp.Pipeline()  # Creates the graph that will carry data from the headset through processing nodes.

# 8 EEG channels at 250 Hz, plus the optional streams: 3 accelerometer,
# 3 gyroscope, and battery, counter, validation. 17 channels in all
source = gp.HybridBlack(    enable_oscar=True,
    include_accel=False,
    include_gyro=False,
    include_aux=False,)

# BIOMARKER PIPEINE
frontal = gp.ChannelSelector(labels=FRONTAL_CHANNELS)
frontal_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
frontal_power = gp.BandPower(bands=["theta"])
frontal_out = gp.Collector(name="frontal_theta")

pipeline.connect(source, frontal)
pipeline.connect(frontal, frontal_fft)
pipeline.connect(frontal_fft, frontal_power)
pipeline.connect(frontal_power, frontal_out)

posterior = gp.ChannelSelector(labels=POSTERIOR_CHANNELS)
posterior_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
posterior_power = gp.BandPower(bands=["alpha"])
posterior_out = gp.Collector(name="posterior_alpha")

pipeline.connect(source, posterior)
pipeline.connect(posterior, posterior_fft)
pipeline.connect(posterior_fft, posterior_power)
pipeline.connect(posterior_power, posterior_out)

central = gp.ChannelSelector(labels=CENTRAL_CHANNELS)
central_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
central_power = gp.BandPower(bands=["beta"])
central_out = gp.Collector(name="central_beta")

pipeline.connect(source, central)
pipeline.connect(central, central_fft)
pipeline.connect(central_fft, central_power)
pipeline.connect(central_power, central_out)

# ROUTE THE BIOMARKERS
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

# SINK NODES
scope = gp.TimeSeriesScope(name="biomarkers")
writer = gp.CsvWriter(
        file_name=str(
            output_dir / f"attention_biomarkers_{session_id}.csv"
        )
    )

pipeline.connect(
    combined,
    writer,
)
pipeline.connect(
    combined,
    scope,
)

# Start pipeline and run application
pipeline.start()
app.run()  # blocking until window is closed
pipeline.stop()
pipeline.close()