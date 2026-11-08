"""Measure 4–8 Hz theta-band power from the Fz electrode of a Unicorn BCI Core-8."""

import time  # Provides sleep(), which keeps this example running while acquisition happens.

import numpy as np  # Provides array operations for summarising the collected theta-power values.
import gpype as gp  # Imports g.Pype's public pipeline, source, filter, spectral, and sink nodes.

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

source = gp.BCICore(  # Creates the live Bluetooth source for the Unicorn BCI Core amplifier.
    channel_count=8,  # Requests all eight EEG channels from the Core-8.
    sampling_rate=SAMPLING_RATE,  # Declares that the amplifier should stream at 250 Hz.
    enable_oscar=True,  # Enables g.Pype's OSCAR artefact-removal option at the acquisition source.
)  # Finishes construction of the live EEG source.

fft = gp.FFT(window_size=250)


# CALCULATE FRONTAL THETA POWER
frontal = gp.ChannelSelector(labels=FRONTAL_CHANNELS)
frontal_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
frontal_power = gp.BandPower(bands=["theta"])
frontal_out = gp.Collector(name="frontal_theta")

gp.connect(source, frontal)
gp.connect(frontal, frontal_fft)
gp.connect(frontal_fft, frontal_power)
gp.connect(frontal_power, frontal_out)

posterior = gp.ChannelSelector(labels=POSTERIOR_CHANNELS)
posterior_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
posterior_power = gp.BandPower(bands=["alpha"])
posterior_out = gp.Collector(name="posterior_alpha")

gp.connect(source, posterior)
gp.connect(posterior, posterior_fft)
gp.connect(posterior_fft, posterior_power)
gp.connect(posterior_power, posterior_out)

central = gp.ChannelSelector(labels=CENTRAL_CHANNELS)
central_fft = gp.FFT(window_size=FFT_WINDOW_SAMPLES)
central_power = gp.BandPower(bands=["beta"])
central_out = gp.Collector(name="central_beta")

gp.connect(source, central)
gp.connect(central, central_fft)
gp.connect(central_fft, central_power)
gp.connect(central_power, central_out)

scope = gp.TimeSeriesScope(name="biomarkers")
collector = gp.Collector(name="biomarkers")
writer = gp.CsvWriter(file_name="filtered.csv")

gp.connect(source, fft)
gp.connect()

# Start pipeline and run application
gp.start()
app.run()  # blocking until window is closed
gp.stop()
gp.close()