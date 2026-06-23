from __future__ import annotations

import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
FRONTEND_JS_DIR = PROJECT_ROOT / "frontend" / "js"
LOCAL_VERSIONED_IMPORT_PATTERN = re.compile(r'from\s+["\']\./[^"\']+\?v=')
LOCAL_IMPORT_PATTERN = re.compile(r'from\s+["\'](?P<path>\./[^"\']+)["\']')


class FrontendImportTests(unittest.TestCase):
    def test_frontend_local_imports_resolve_to_existing_files(self) -> None:
        """A split module must not fail at browser load because its relative import is missing."""

        missing_imports: list[str] = []
        for script_path in sorted(FRONTEND_JS_DIR.glob("*.js")):
            source = script_path.read_text(encoding="utf-8")
            for match in LOCAL_IMPORT_PATTERN.finditer(source):
                import_path = match.group("path")
                target_path = (script_path.parent / import_path).resolve()
                if not target_path.exists():
                    missing_imports.append(
                        f"{script_path.relative_to(PROJECT_ROOT)} -> {import_path}",
                    )

        self.assertEqual([], missing_imports)

    def test_frontend_modules_do_not_cache_bust_internal_imports(self) -> None:
        """Internal module imports must use one canonical URL per file."""

        offenders: list[str] = []
        for script_path in sorted(FRONTEND_JS_DIR.glob("*.js")):
            source = script_path.read_text(encoding="utf-8")
            if LOCAL_VERSIONED_IMPORT_PATTERN.search(source):
                offenders.append(str(script_path.relative_to(PROJECT_ROOT)))

        self.assertEqual(
            [],
            offenders,
            "Use the HTML entrypoint version only; versioned internal imports can duplicate module state.",
        )

    def test_bottom_progress_only_consumes_backend_progress_event(self) -> None:
        """Map-derived progress must not drive the global bottom progress bar."""

        main_source = (FRONTEND_JS_DIR / "main.js").read_text(encoding="utf-8")
        status_source = (FRONTEND_JS_DIR / "simulation_status.js").read_text(encoding="utf-8")
        map_source = (FRONTEND_JS_DIR / "map.js").read_text(encoding="utf-8")

        self.assertIn('window.addEventListener("dss:progress"', status_source)
        self.assertNotIn("dss:route-progress", main_source)
        self.assertNotIn("dss:route-progress", status_source)
        self.assertNotIn("dss:route-progress", map_source)
        self.assertNotIn("progress-fill.style.width", status_source)
        self.assertIn("Number.isFinite(numericPercent)", status_source)

    def test_socket_payload_parsing_is_defensive(self) -> None:
        """Malformed WebSocket payloads must not escape JSON.parse exceptions."""

        socket_source = (FRONTEND_JS_DIR / "socket.js").read_text(encoding="utf-8")

        self.assertIn("function parseSocketPayload", socket_source)
        self.assertIn("try {", socket_source)
        self.assertIn("JSON.parse(data)", socket_source)
        self.assertIn("catch (error)", socket_source)
        self.assertIn("const payload = parseSocketPayload(event.data)", socket_source)

    def test_navigation_menu_and_panel_events_keep_single_owner(self) -> None:
        """The right panel hamburger flow should stay owned by scenario_builder.js."""

        main_source = (FRONTEND_JS_DIR / "main.js").read_text(encoding="utf-8")
        scenario_builder_source = (FRONTEND_JS_DIR / "scenario_builder.js").read_text(encoding="utf-8")

        self.assertIn("function setNavigationMenuOpen", scenario_builder_source)
        self.assertIn("function syncNavigationPlacement", scenario_builder_source)
        self.assertIn('new CustomEvent("dss:panel-tab-change"', scenario_builder_source)
        self.assertIn('window.addEventListener("dss:panel-tab-change"', main_source)
        self.assertNotIn("function setNavigationMenuOpen", main_source)
        self.assertNotIn("map-hud?.classList.toggle", main_source)

    def test_index_keeps_required_app_shell_elements(self) -> None:
        """Core controls should not disappear from index.html during UI edits."""

        index_source = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
        required_ids = [
            "map-hud",
            "map-menu-button",
            "right-tabs",
            "stream-status",
            "map-status",
            "progress-wrap",
            "progress-fill",
            "progress-pct",
            "start-button",
            "pause-button",
            "reset-button",
            "save-button",
            "simulation-repeat-count-input",
            "live-arm-button",
            "live-disarm-button",
            "live-takeoff-button",
            "live-land-button",
            "live-rth-button",
            "live-hold-button",
            "live-upload-button",
            "live-start-button",
            "flight-summary-avg-alt",
            "flight-summary-avg-speed",
            "drone-1-select",
            "scenario-1-select",
            "live-panel",
            "builder-panel",
            "flight-panel",
        ]

        missing_ids = [
            element_id
            for element_id in required_ids
            if f'id="{element_id}"' not in index_source
        ]

        self.assertEqual([], missing_ids)
        self.assertNotIn("flight-summary-max-alt", index_source)
        self.assertNotIn("flight-summary-max-speed", index_source)
