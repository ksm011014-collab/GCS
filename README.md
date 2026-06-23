# Drone Simulation System

## Purpose

This project generates simulated drone flight data for C-UAS threat analysis and algorithm development.

The main goal is to collect repeatable flight logs and state data without relying on real-world flights.

## Current Structure

- `backend/`: simulation engine, API, WebSocket, logging
- `frontend/`: browser UI for control, visualization, and log inspection
- `scenarios/`: scenario definition files
- `logs/`: generated simulation output

## Recommended Python Version

Use Python 3.11 or 3.12 for this project.

The current local environment is Python 3.14, which may cause package compatibility issues.

## Initial Setup

1. Create or activate the virtual environment.
2. Install dependencies from `requirements.txt`.
3. Start frontend work with mock data first.
4. Add backend simulation and logging after the data format is fixed.

## Desktop App Build

The desktop build keeps the existing FastAPI and WebSocket architecture. `DSS.exe`
starts the backend on `127.0.0.1:8000` and opens the UI in a Chrome or Edge app
window.

Build on Windows:

```powershell
.\build-desktop.ps1
```

If PowerShell blocks local scripts, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1
```

Run:

```powershell
.\dist\DSS\DSS.exe
```

Runtime files are stored next to the executable:

- `logs/`
- `scenarios/custom/`
- `browser-profile/`

The map currently depends on the external Leaflet CDN used by `frontend/index.html`,
so the desktop app still needs network access for the map library unless those assets
are vendored locally.
