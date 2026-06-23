# AGENTS.md — Drone Simulation System (Codex Optimized)



## Project Overview

Web-based drone flight simulation system using DJI specs.

Simulates physics, streams telemetry via WebSocket, visualizes on map, and logs sortie data.

## Platform Vision

This project is intended to evolve from a drone simulation system into a data-driven ground control platform that supports both counter-drone defense algorithm validation and drone operator education and training.

### Primary Mission

- Support validation of counter-drone defense logic using scenario-driven simulated flight data
- Support real-world drone operations through an integrated ground control interface
- Support operator education and training through flight data capture, replay, and performance evaluation

### Current Phase

The initial platform should be developed as a multi-tab system with two core modules.

Simulation tab:

- Generate diverse threat scenarios
- Collect flight and engagement data efficiently
- Build datasets for defense algorithm verification

Control system tab:

- Integrate with real aircraft when available
- Support waypoint-based route planning
- Provide real-time situational monitoring
- Save flight logs automatically

### Planned AI Expansion

Simulation-side AI goals:

- Estimate expected threat level of hostile drones automatically
- Compare AI-derived threat estimates against existing defense algorithm outputs
- Support validation and analysis workflows for defense logic

Control-side AI goals:

- Analyze flight data to quantify piloting stability and proficiency
- Support training evaluation and historical performance management

### End State

The final platform should be usable across defense research, real-world operations, and operator training as a common integrated drone operations support system.



---



## Project Structure



backend/

- main.py            # FastAPI entrypoint

- __init__.py        # For package recognition

- physics.py         # RK4 physics engine

- drone_specs.py     # drone spec database

- swarm.py           # DBSCAN clustering

- scenario.py        # scenario parsing

- logger.py          # async logging (SQLite)

- ws_manager.py      # websocket manager



frontend/

- index.html

- css/style.css

- js/

  - map.js

  - telemetry.js

  - sidebar.js

  - log.js

  - scenario.js

  - socket.js

  - main.js



scenarios/

logs/



---



## Data Flow



Backend:

physics → swarm → ws_manager → WebSocket



Frontend:

socket.js → (event dispatch) →

  - map.js

  - telemetry.js

  - log.js



---



## WebSocket Rules



All messages MUST include:

- type field



Telemetry message:

- MUST follow existing schema exactly

- DO NOT change field names



Log message:

- append-only behavior



---



## API Rules



- Do not modify existing endpoints

- Do not change request/response format

- Maintain backward compatibility



---



## Code Rules



### Python

- Use type hints (mandatory)

- Physics functions must be pure functions

- No blocking code in simulation loop

- logger.py must remain async



### JavaScript

- socket.js is the ONLY entry for WebSocket data

- Use CustomEvent for data propagation

- No cross-module DOM manipulation

- map.js exclusively manages Leaflet instance



---



## Simulation Rules



- RK4 integration (dt = 0.05s)

- Use WGS84 (Lat, Lon, Alt) for all coordinate calculations

- Enforce drone spec limits (speed, accel)

- Do not introduce unrealistic physics changes



---



## Modification Rules



- Modify ONLY necessary files

- Do not change unrelated modules

- Do not rename files or folders

- Preserve existing architecture



---



## Do NOT



- Do not refactor entire project

- Do not change WebSocket schema

- Do not break API endpoints

- Do not introduce new frameworks

- Do not move logic across modules



---



## Workflow



1. Understand the task

2. Identify affected files

3. Apply minimal changes

4. Verify:

   - backend runs

   - WebSocket data flow works

   - frontend updates correctly



---



## Execution



Backend:

uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000



Frontend:

Open index.html or use Live Server



---



## Performance Constraints



- Avoid excessive WebSocket broadcasting

- Avoid large DOM updates per tick

- Optimize path rendering if needed



---



## Known Constraints



- DJI parameters are approximations

- No wind / terrain / motor modeling

- High drone count may degrade performance



--- 
