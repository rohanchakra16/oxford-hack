"""PySide6 GUI and controller for labelled EEG dataset construction.

The GUI delegates recording lifecycle operations to ``RecordingManager``.
Device connection and database persistence run in Qt worker threads, while
the manager's acquisition collector remains independent of the GUI thread.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Callable

from PySide6.QtCore import QObject, QThread, QTimer, Signal, Slot
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from eeg.acquisition import EEGDevice, create_device
from eeg.dataset.recording_database import RecordingDatabase
from eeg.dataset.recording_manager import (
    RecordingManager,
    RecordingManagerError,
    RecordingState,
)
from eeg.realtime.feature_extractor import EEGFeatureExtractor
from eeg.realtime.feature_registry import FeatureRegistry
from eeg.realtime.stub_features import STUB_FEATURES
from eeg.utils.configuration import load_config


class OperationThread(QThread):
    """Run one controller operation away from the GUI event loop."""

    def __init__(self, operation: Callable[[], Any], parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._operation = operation
        self.result: Any = None
        self.error: Exception | None = None

    def run(self) -> None:
        try:
            self.result = self._operation()
        except Exception as error:
            self.error = error


class DatasetController(QObject):
    """Qt controller adapting devices and ``RecordingManager`` to the GUI."""

    status_changed = Signal(object)
    connection_changed = Signal(bool)
    recordings_changed = Signal(object)
    operation_failed = Signal(str)
    operation_finished = Signal()

    def __init__(
        self,
        database: RecordingDatabase,
        *,
        device_types: tuple[str, ...] = ("mock", "unicorn"),
        feature_extractor: EEGFeatureExtractor | None = None,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self.database = database
        self.device_types = device_types
        self.feature_extractor = feature_extractor
        self.device: EEGDevice | None = None
        self.manager: RecordingManager | None = None
        self._thread: QThread | None = None
        self._success_callback: Callable[[Any], None] | None = None
        self._completion_timer = QTimer(self)
        self._completion_timer.timeout.connect(self._poll_thread)

    def connect_device(self, device_type: str) -> None:
        """Create and connect a selected device without blocking the GUI."""
        if self.manager is not None:
            self.operation_failed.emit("Disconnect the current device first")
            return
        try:
            device = create_device(device_type)
        except Exception as error:
            self.operation_failed.emit(str(error))
            return
        self._run_async(
            device.connect,
            on_success=lambda _result: self._connected(device),
        )

    def _connected(self, device: EEGDevice) -> None:
        self.device = device
        self.manager = RecordingManager(
            device,
            self.database,
            feature_extractor=self.feature_extractor,
        )
        self.connection_changed.emit(True)

    def disconnect_device(self) -> None:
        """Disconnect the selected device after lifecycle state validation."""
        if self.manager is None or self.device is None:
            return
        if self.manager.get_recording_status().state is not RecordingState.IDLE:
            self.operation_failed.emit("Save or discard the current recording first")
            return
        self._run_async(
            self._disconnect_device,
            on_success=lambda _result: self.connection_changed.emit(False),
        )

    def _disconnect_device(self) -> None:
        assert self.device is not None
        self.device.disconnect()
        self.device = None
        self.manager = None

    def start_recording(self, label: str) -> None:
        """Start recording through ``RecordingManager``."""
        if self.manager is None:
            self.operation_failed.emit("Connect a device first")
            return
        try:
            self.manager.start_recording(label)
            self.status_changed.emit(self.manager.get_recording_status())
        except Exception as error:
            self.operation_failed.emit(str(error))

    def stop_recording(self) -> None:
        """Stop acquisition and expose the review-pending state."""
        if self.manager is None:
            self.operation_failed.emit("Connect a device first")
            return
        manager = self.manager
        self._run_async(
            manager.stop_recording,
            on_success=lambda _result: self.status_changed.emit(
                manager.get_recording_status()
            ),
        )

    def save_recording(self) -> None:
        """Persist the pending raw recording in a worker thread."""
        if self.manager is None:
            self.operation_failed.emit("No recording manager is available")
            return
        self._run_async(
            self.manager.save_recording,
            on_success=lambda _metadata: self._saved(),
        )

    def _saved(self) -> None:
        assert self.manager is not None
        self.status_changed.emit(self.manager.get_recording_status())
        self.refresh_recordings()

    def discard_recording(self) -> None:
        """Discard the pending temporary recording without persistence."""
        if self.manager is None:
            self.operation_failed.emit("No recording manager is available")
            return
        try:
            self.manager.discard_recording()
            self.status_changed.emit(self.manager.get_recording_status())
        except Exception as error:
            self.operation_failed.emit(str(error))

    def refresh_recordings(self) -> None:
        self.recordings_changed.emit(self.database.list_recordings())

    def shutdown(self) -> None:
        """Stop worker activity and disconnect an idle device during teardown."""
        if self._thread is not None:
            self._thread.quit()
            self._thread.wait(2000)
            self._thread = None
        if self.manager is not None and self.device is not None:
            if self.manager.get_recording_status().state is RecordingState.IDLE:
                self.device.disconnect()
                self.device = None
                self.manager = None

    def _run_async(
        self, operation: Callable[[], Any], on_success: Callable[[Any], None] | None = None
    ) -> None:
        if self._thread is not None:
            self.operation_failed.emit("Another device operation is in progress")
            return
        thread = OperationThread(operation, self)
        self._thread = thread
        self._success_callback = on_success
        thread.start()
        self._completion_timer.start(10)

    @Slot()
    def _poll_thread(self) -> None:
        if self._thread is not None and self._thread.isFinished():
            self._completion_timer.stop()
            self._operation_finished()

    @Slot()
    def _operation_finished(self) -> None:
        thread = self._thread
        self._thread = None
        if thread is not None and thread.error is not None:
            self.operation_failed.emit(str(thread.error))
        elif thread is not None and self._success_callback is not None:
            self._success_callback(thread.result)
        self._success_callback = None
        self.operation_finished.emit()


class SaveDiscardDialog(QDialog):
    """Modal dialog requiring an explicit save or discard selection."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Recording complete")
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Save this recording or discard it?"))
        buttons = QDialogButtonBox(self)
        self.save_button = buttons.addButton("Save Recording", QDialogButtonBox.AcceptRole)
        self.discard_button = buttons.addButton("Discard Recording", QDialogButtonBox.DestructiveRole)
        self.save_button.clicked.connect(self.accept)
        self.discard_button.clicked.connect(self.reject)
        layout.addWidget(buttons)


class DatasetWindow(QMainWindow):
    """Dataset construction window with device, label, recording, and list sections."""

    def __init__(self, controller: DatasetController, labels: tuple[str, ...], parent=None):
        super().__init__(parent)
        self.controller = controller
        self._recording_started_at: float | None = None
        self.setWindowTitle("EEG Dataset Construction")
        self._build_ui(labels)
        self._connect_signals()
        self._update_controls()
        self.controller.refresh_recordings()

    def _build_ui(self, labels: tuple[str, ...]) -> None:
        root = QWidget(self)
        layout = QVBoxLayout(root)
        device_row = QHBoxLayout()
        self.device_combo = QComboBox()
        self.device_combo.addItems(self.controller.device_types)
        self.connect_button = QPushButton("Connect")
        self.disconnect_button = QPushButton("Disconnect")
        self.connection_status = QLabel("Disconnected")
        device_row.addWidget(self.device_combo)
        device_row.addWidget(self.connect_button)
        device_row.addWidget(self.disconnect_button)
        device_row.addWidget(self.connection_status)
        layout.addLayout(device_row)

        form = QFormLayout()
        self.label_combo = QComboBox()
        self.label_combo.addItems(labels)
        form.addRow("Label", self.label_combo)
        self.feature_status = QLabel()
        form.addRow("Training features", self.feature_status)
        layout.addLayout(form)

        recording_row = QHBoxLayout()
        self.start_button = QPushButton("Start Recording")
        self.stop_button = QPushButton("Stop Recording")
        self.recording_status = QLabel("Idle")
        self.duration_label = QLabel("0.0 s")
        recording_row.addWidget(self.start_button)
        recording_row.addWidget(self.stop_button)
        recording_row.addWidget(self.recording_status)
        recording_row.addWidget(self.duration_label)
        layout.addLayout(recording_row)

        self.recordings_list = QListWidget()
        layout.addWidget(QLabel("Saved recordings"))
        layout.addWidget(self.recordings_list)
        self.setCentralWidget(root)
        self._duration_timer = QTimer(self)
        self._duration_timer.timeout.connect(self._update_duration)

    def _connect_signals(self) -> None:
        self.connect_button.clicked.connect(
            lambda: self.controller.connect_device(self.device_combo.currentText())
        )
        self.disconnect_button.clicked.connect(self.controller.disconnect_device)
        self.start_button.clicked.connect(
            lambda: self._start_recording(self.label_combo.currentText())
        )
        self.stop_button.clicked.connect(self.controller.stop_recording)
        self.controller.connection_changed.connect(self._connection_changed)
        self.controller.status_changed.connect(self._status_changed)
        self.controller.recordings_changed.connect(self._recordings_changed)
        self.controller.operation_finished.connect(self._operation_finished)
        self.controller.operation_failed.connect(self._show_error)

    def _start_recording(self, label: str) -> None:
        self.controller.start_recording(label)
        self._recording_started_at = time.monotonic()
        self._duration_timer.start(100)

    def _connection_changed(self, connected: bool) -> None:
        self.connection_status.setText("Connected" if connected else "Disconnected")
        self._update_controls()

    def _status_changed(self, status) -> None:
        self.recording_status.setText(status.state.value.replace("_", " ").title())
        if status.state is RecordingState.REVIEW_PENDING:
            self._duration_timer.stop()
            dialog = SaveDiscardDialog(self)
            if dialog.exec() == QDialog.Accepted:
                self.controller.save_recording()
            else:
                self.controller.discard_recording()
        elif status.state is RecordingState.IDLE:
            self._recording_started_at = None
            self._update_duration()
        self._update_controls()

    def _recordings_changed(self, recordings) -> None:
        self.recordings_list.clear()
        for recording in recordings:
            item = QListWidgetItem(
                f"{recording.recording_id} | {recording.label} | "
                f"{recording.duration_seconds:.2f}s | {recording.created_at} | "
                f"{recording.sample_count} samples"
            )
            self.recordings_list.addItem(item)

    def _operation_finished(self) -> None:
        """Resynchronize controls after an asynchronous controller action."""
        self._update_controls()

    def _update_duration(self) -> None:
        elapsed = time.monotonic() - self._recording_started_at if self._recording_started_at else 0
        self.duration_label.setText(f"{elapsed:.1f} s")

    def _update_controls(self) -> None:
        connected = self.controller.manager is not None
        state = self.controller.manager.get_recording_status().state if connected else RecordingState.IDLE
        self.connect_button.setEnabled(not connected)
        self.disconnect_button.setEnabled(connected and state is RecordingState.IDLE)
        self.start_button.setEnabled(connected and state is RecordingState.IDLE)
        self.stop_button.setEnabled(connected and state is RecordingState.RECORDING)
        self.label_combo.setEnabled(connected and state is RecordingState.IDLE)

    def _show_error(self, message: str) -> None:
        QMessageBox.warning(self, "EEG operation failed", message)
        self._update_controls()

    def closeEvent(self, event) -> None:
        self.controller.shutdown()
        super().closeEvent(event)


def labels_from_config(config_path: str | Path) -> tuple[str, ...]:
    """Read dataset labels from YAML configuration."""
    config = load_config(config_path)
    labels = config.get("dataset", {}).get("labels", [])
    if not isinstance(labels, list) or not labels or not all(isinstance(label, str) for label in labels):
        raise ValueError("dataset.labels must be a non-empty list of strings")
    return tuple(labels)


def feature_extractor_from_config(config: dict[str, Any]) -> EEGFeatureExtractor:
    """Build an extractor from configured placeholder or user-registered features."""
    features = config.get("features", {})
    enabled = features.get("enabled", [])
    settings = features.get("settings", {})
    registry = FeatureRegistry()
    for name in enabled:
        if name not in STUB_FEATURES:
            raise ValueError(f"Feature '{name}' is not registered")
        registry.register(name, STUB_FEATURES[name], config=settings.get(name))
    return EEGFeatureExtractor(registry)


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config.yaml"


def run(config_path: str | Path = DEFAULT_CONFIG_PATH, database_path: str | Path = "recordings.sqlite") -> int:
    """Run the dataset construction application."""
    application = QApplication.instance() or QApplication(sys.argv)
    database = RecordingDatabase(database_path)
    controller = DatasetController(database)
    config = load_config(config_path)
    extractor = feature_extractor_from_config(config)
    controller.feature_extractor = extractor
    window = DatasetWindow(controller, labels_from_config(config_path))
    window.feature_status.setText(", ".join(extractor.registry.list_features()) or "None")
    window.show()
    return application.exec()
