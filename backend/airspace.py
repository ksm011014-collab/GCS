from __future__ import annotations

import os

import httpx
from fastapi import HTTPException


MOLIT_AIRSPACE_DATA_URL = "https://api.vworld.kr/req/data"
MOLIT_AIRSPACE_DATASETS = {
    "prohibited": {
        "data": "LT_C_AISPRHC",
        "label": "비행금지구역",
    },
    "restricted": {
        "data": "LT_C_AISRESC",
        "label": "비행제한구역",
    },
}
MOLIT_AIRSPACE_KEY_ENV_NAMES = (
    "MOLIT_AIRSPACE_API_KEY",
    "DATA_GO_KR_SERVICE_KEY",
    "VWORLD_API_KEY",
    "VWORLD_KEY",
)


class AirspaceDataFetchError(RuntimeError):
    """Raised when the upstream public airspace API cannot be reached."""


def get_molit_airspace_api_key() -> str:
    """Return the configured public airspace API key, if available."""

    for env_name in MOLIT_AIRSPACE_KEY_ENV_NAMES:
        api_key = os.getenv(env_name, "").strip()
        if api_key:
            return api_key
    return ""


def parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    """Parse a WGS84 bbox in minLon,minLat,maxLon,maxLat order."""

    try:
        min_lon, min_lat, max_lon, max_lat = [float(value) for value in bbox.split(",")]
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="bbox must be minLon,minLat,maxLon,maxLat.",
        ) from exc

    if min_lon >= max_lon or min_lat >= max_lat:
        raise HTTPException(status_code=400, detail="bbox minimums must be less than maximums.")
    if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180):
        raise HTTPException(status_code=400, detail="bbox longitude must be between -180 and 180.")
    if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
        raise HTTPException(status_code=400, detail="bbox latitude must be between -90 and 90.")

    return min_lon, min_lat, max_lon, max_lat


def build_molit_airspace_params(
    *,
    api_key: str,
    dataset_key: str,
    bbox: tuple[float, float, float, float],
    page: int = 1,
    size: int = 1000,
) -> dict[str, str]:
    """Build a constrained public airspace REST request."""

    min_lon, min_lat, max_lon, max_lat = bbox
    return {
        "service": "data",
        "version": "2.0",
        "request": "GetFeature",
        "format": "json",
        "errorFormat": "json",
        "key": api_key,
        "data": MOLIT_AIRSPACE_DATASETS[dataset_key]["data"],
        "geomFilter": f"BOX({min_lon},{min_lat},{max_lon},{max_lat})",
        "geometry": "true",
        "attribute": "true",
        "crs": "EPSG:4326",
        "page": str(page),
        "size": str(size),
    }


async def fetch_molit_airspace_payload(params: dict[str, str]) -> dict:
    """Fetch public airspace data from the linked MOLIT spatial data API."""

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(MOLIT_AIRSPACE_DATA_URL, params=params)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise AirspaceDataFetchError("Failed to fetch public airspace data.") from exc
    return response.json()


def extract_airspace_features(payload: dict, zone_type: str) -> list[dict]:
    """Extract GeoJSON features from known public data response shapes."""

    result = payload.get("response", {}).get("result", payload.get("result", payload))
    candidates = []
    if isinstance(result, dict):
        candidates.extend(
            value
            for value in result.values()
            if isinstance(value, dict) and value.get("type") == "FeatureCollection"
        )
        if result.get("type") == "FeatureCollection":
            candidates.append(result)
    elif isinstance(result, list):
        candidates.extend(
            value
            for value in result
            if isinstance(value, dict) and value.get("type") == "FeatureCollection"
        )

    features: list[dict] = []
    for collection in candidates:
        for feature in collection.get("features", []):
            if not isinstance(feature, dict) or not feature.get("geometry"):
                continue
            properties = feature.get("properties")
            if not isinstance(properties, dict):
                properties = {}
            feature["properties"] = {
                **properties,
                "zone_type": zone_type,
                "zone_type_label": MOLIT_AIRSPACE_DATASETS[zone_type]["label"],
                "source": "국토교통부 공공데이터",
            }
            features.append(feature)
    return features
