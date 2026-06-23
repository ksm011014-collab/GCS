from __future__ import annotations

from fastapi import WebSocket


class WebSocketManager:
    """Tracks active websocket clients and broadcasts JSON payloads."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)

    async def send_json(self, websocket: WebSocket, payload: dict[str, object]) -> None:
        await websocket.send_json(payload)

    async def broadcast_json(self, payload: dict[str, object]) -> None:
        for websocket in tuple(self._connections):
            await websocket.send_json(payload)
