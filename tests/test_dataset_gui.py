import os

import pytest

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication
from PySide6.QtTest import QSignalSpy, QTest

from eeg.dataset.dataset_gui import DatasetController, DatasetWindow, labels_from_config
from eeg.dataset.recording_database import RecordingDatabase
from eeg.dataset.recording_manager import RecordingState


@pytest.fixture
def application():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    yield app


def test_labels_are_loaded_from_configuration() -> None:
    labels = labels_from_config("config.yaml")
    assert labels == ("Focused", "Distracted", "Relaxed", "Drowsy", "Other")


def test_window_has_required_sections(application, tmp_path) -> None:
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    controller = DatasetController(database, device_types=("mock",))
    window = DatasetWindow(controller, ("Focused", "Other"))

    assert window.label_combo.count() == 2
    assert window.start_button.isEnabled() is False
    assert window.stop_button.isEnabled() is False
    assert window.recordings_list.count() == 0

    window.close()
    database.close()


def test_controller_connects_mock_device_off_gui_thread(application, tmp_path) -> None:
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    controller = DatasetController(database, device_types=("mock",))
    connected = QSignalSpy(controller.connection_changed)

    controller.connect_device("mock")
    QTest.qWait(100)

    assert connected.count() == 1
    assert connected.at(0)[0] is True
    assert controller.manager is not None

    controller.disconnect_device()
    QTest.qWait(100)
    assert connected.count() == 2
    assert connected.at(1)[0] is False
    database.close()


def test_window_reenables_recording_after_idle_status(application, tmp_path) -> None:
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    controller = DatasetController(database, device_types=("mock",))
    window = DatasetWindow(controller, ("Focused",))

    controller.connect_device("mock")
    QTest.qWait(100)
    assert window.start_button.isEnabled() is True

    window.start_button.setEnabled(False)
    controller.operation_finished.emit()
    assert controller.manager.get_recording_status().state is RecordingState.IDLE
    assert window.start_button.isEnabled() is True

    window.close()
    controller.shutdown()
    database.close()
