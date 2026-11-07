"""Integrity-checked public EEGMAT 1.0.0 download into ignored local storage."""

import argparse
import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen

DATASET_URL = "https://physionet.org/content/eegmat/1.0.0/"
FILES_URL = "https://physionet.org/files/eegmat/1.0.0/"
CHECKSUMS_SHA256 = "85c71151495c8543e80fd48559cb62eca7b6c407ed5e96c8e490db7ecabf1fa0"
SUBJECTS = tuple(f"Subject{i:02d}" for i in range(36))
EDF_FILES = tuple(f"{subject}_{condition}.edf" for subject in SUBJECTS for condition in (1, 2))
DEFAULT_DATA = Path(__file__).resolve().parents[1] / "inference" / ".local" / "eegmat"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _download(name: str, destination: Path) -> None:
    # Filenames come only from the fixed allowlist, never remote directory listings.
    with urlopen(FILES_URL + name, timeout=60) as response:
        payload = response.read()
    destination.write_bytes(payload)


def checksum_manifest(root: Path) -> dict[str, str]:
    source = root / "SHA256SUMS.txt"
    if sha256(source) != CHECKSUMS_SHA256:
        raise ValueError("EEGMAT checksum manifest differs from pinned version")
    return {
        name: checksum
        for checksum, name in (
            line.split() for line in source.read_text(encoding="utf-8").splitlines() if line.strip()
        )
    }


def verify_dataset(root: Path) -> dict[str, str]:
    expected = checksum_manifest(root)
    hashes = {}
    for name in EDF_FILES:
        if not (root / name).is_file() or sha256(root / name) != expected[name]:
            raise ValueError(f"missing or checksum-mismatched recording: {name}")
        hashes[name] = expected[name]
    return hashes


def download(root: Path = DEFAULT_DATA) -> dict[str, str]:
    repository = Path(__file__).resolve().parents[2]
    allowed = (repository / "src" / "inference" / ".local", repository / "data")
    if not any(root.resolve().is_relative_to(path.resolve()) for path in allowed):
        raise ValueError("recordings must stay under ignored src/inference/.local/ or data/")
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "SHA256SUMS.txt"
    if not manifest.exists():
        _download("SHA256SUMS.txt", manifest)
    expected = checksum_manifest(root)

    def fetch(name: str) -> str:
        path = root / name
        if path.exists() and sha256(path) == expected[name]:
            return name
        temporary = path.with_suffix(".edf.part")
        _download(name, temporary)
        if sha256(temporary) != expected[name]:
            raise ValueError(f"download checksum mismatch: {name}")
        temporary.replace(path)
        return name

    with ThreadPoolExecutor(max_workers=4) as pool:
        for i, _ in enumerate(pool.map(fetch, EDF_FILES), 1):
            if i % 12 == 0:
                print(f"Verified {i}/{len(EDF_FILES)} EEGMAT files", flush=True)
    return verify_dataset(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    download(args.data_dir)
