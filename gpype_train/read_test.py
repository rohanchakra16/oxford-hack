# --------------------------------------------------------------
# Example file s2e1_lowpass.py
# For details and usage, see g.Pype Training Season 2, Episode 1
# --------------------------------------------------------------

import gpype as gp

if __name__ == "__main__":

    # Create main app and pipeline
    app = gp.MainApp()
    p = gp.Pipeline()

    # Create signal source
    source = gp.BCICore()
    # Create lowpass filter
    lowpass = gp.Lowpass(f_c=6)

    # Create scope
    scope = gp.TimeSeriesScope()

    # Keep a copy of the same filtered stream in memory
    collected = gp.Collector(name="filtered")

    writer = gp.CsvWriter(file_name="filtered.csv")
    p.connect(lowpass, writer)

    # Connect nodes
    p.connect(source, lowpass)
    p.connect(lowpass, scope)
    p.connect(lowpass, collected)

    # Add widget to main app
    app.add_widget(scope)

    # Start pipeline and run application
    p.start()
    app.run()  # blocking until window is closed
    p.stop()
    p.close()

    # The GUI shows the data while the Collector makes it available here
    result = collected.result
    if result is None:
        raise RuntimeError("The pipeline produced no filtered data")
    print(f"Captured data shape (time, channels): {result.data.shape}")
    print(f"Sampling rate: {result.rate} Hz")
