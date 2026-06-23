from __future__ import annotations

import shutil
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def is_frozen_app() -> bool:
    """Return whether the process is running from a PyInstaller bundle."""

    return bool(getattr(sys, "frozen", False))


def bundled_root() -> Path:
    """Return the directory that contains bundled read-only assets."""

    return Path(getattr(sys, "_MEIPASS", PROJECT_ROOT))


def runtime_root() -> Path:
    """Return the writable runtime directory for logs and user scenarios."""

    if is_frozen_app():
        return Path(sys.executable).resolve().parent
    return PROJECT_ROOT


def bundled_path(*parts: str) -> Path:
    """Resolve a path from packaged project assets."""

    return bundled_root().joinpath(*parts)


def runtime_path(*parts: str) -> Path:
    """Resolve a path from the writable runtime directory."""

    return runtime_root().joinpath(*parts)


def seed_runtime_directory(relative_directory: str) -> None:
    """Copy packaged seed files to the runtime directory without overwriting user data."""

    source_directory = bundled_path(relative_directory)
    destination_directory = runtime_path(relative_directory)
    destination_directory.mkdir(parents=True, exist_ok=True)

    if not source_directory.exists():
        return

    for source_path in source_directory.rglob("*"):
        if not source_path.is_file():
            continue
        relative_path = source_path.relative_to(source_directory)
        destination_path = destination_directory / relative_path
        if destination_path.exists():
            continue
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination_path)


def prepare_runtime_directories() -> None:
    """Create writable folders used by the desktop executable."""

    runtime_path("logs").mkdir(parents=True, exist_ok=True)
    runtime_path("drone_specs", "custom").mkdir(parents=True, exist_ok=True)
    seed_runtime_directory("scenarios/custom")
