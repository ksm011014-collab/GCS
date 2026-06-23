from __future__ import annotations

import os
import socket
import subprocess
import threading
import time
import traceback
import webbrowser
from pathlib import Path
from typing import Final

import uvicorn

from backend.paths import prepare_runtime_directories
from backend.paths import runtime_path


APP_HOST: Final[str] = "127.0.0.1"
APP_PORT: Final[int] = 8000
APP_URL: Final[str] = f"http://{APP_HOST}:{APP_PORT}/app?v=20260415_mobile_menu"


def wait_until_server_ready(host: str, port: int, timeout_seconds: float = 15.0) -> None:
    """Block until the embedded FastAPI server accepts local TCP connections."""

    deadline = time.monotonic() + timeout_seconds
    last_error: OSError | None = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError as error:
            last_error = error
            time.sleep(0.1)

    raise RuntimeError(f"DSS server did not start on {host}:{port}") from last_error


def run_server() -> None:
    """Run the FastAPI backend in-process for the desktop shell."""

    try:
        from backend.main import app

        uvicorn.run(
            app,
            host=APP_HOST,
            port=APP_PORT,
            log_level="warning",
            log_config=None,
            access_log=False,
        )
    except Exception as error:
        write_launcher_error(error)
        raise


def candidate_browser_paths() -> list[Path]:
    """Return Windows browser executables that support app-window mode."""

    candidates = [
        Path("C:/Program Files/Google/Chrome/Application/chrome.exe"),
        Path("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
        Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
        Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
    ]
    return [candidate for candidate in candidates if candidate.exists()]


def wait_forever() -> None:
    """Keep the embedded server alive when no app-window process can be tracked."""

    while True:
        time.sleep(3600)


def write_launcher_error(error: BaseException) -> None:
    """Persist startup errors from the windowed executable."""

    log_path = runtime_path("logs", "desktop_launcher_error.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as output_file:
        output_file.write("\n--- DSS launcher error ---\n")
        output_file.write("".join(traceback.format_exception(error)))


def open_desktop_window() -> None:
    """Open the DSS UI in a browser app window and block until it closes."""

    browser_paths = candidate_browser_paths()
    if browser_paths:
        profile_directory = runtime_path("browser-profile")
        profile_directory.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(
            [
                str(browser_paths[0]),
                f"--app={APP_URL}",
                f"--user-data-dir={profile_directory}",
                "--no-first-run",
            ],
        )
        process.wait()
        return

    webbrowser.open(APP_URL)
    wait_forever()


def main() -> None:
    """Start the bundled backend and open the desktop UI."""

    try:
        prepare_runtime_directories()
        server_thread = threading.Thread(target=run_server, name="dss-server", daemon=True)
        server_thread.start()
        wait_until_server_ready(APP_HOST, APP_PORT)
        if os.environ.get("DSS_NO_BROWSER") == "1":
            wait_forever()
        open_desktop_window()
    except Exception as error:
        write_launcher_error(error)
        raise


if __name__ == "__main__":
    main()
