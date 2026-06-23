from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class FormationGroup:
    """Shared first-waypoint synchronization state for a formation session."""

    expected_members: int
    active_members: set[str] = field(default_factory=set)
    ready_members: set[str] = field(default_factory=set)
    released: bool = False
    release_event: asyncio.Event = field(default_factory=asyncio.Event)


class FormationSyncManager:
    """Coordinate one-time first-waypoint release across formation members."""

    def __init__(self) -> None:
        self._groups: dict[str, FormationGroup] = {}
        self._lock = asyncio.Lock()

    async def register_member(
        self,
        session_id: str,
        member_id: str,
        expected_members: int,
    ) -> None:
        """Register a member into a formation session."""

        if not session_id or expected_members <= 1:
            return

        async with self._lock:
            group = self._groups.get(session_id)
            if group is None:
                group = FormationGroup(expected_members=max(1, expected_members))
                self._groups[session_id] = group
            else:
                group.expected_members = max(group.expected_members, expected_members)

            group.active_members.add(member_id)

    async def wait_for_first_waypoint_release(
        self,
        session_id: str,
        member_id: str,
        expected_members: int,
    ) -> bool:
        """Mark a member ready and wait until the whole formation is released."""

        if not session_id or expected_members <= 1:
            return False

        async with self._lock:
            group = self._groups.get(session_id)
            if group is None:
                group = FormationGroup(expected_members=max(1, expected_members))
                self._groups[session_id] = group
            else:
                group.expected_members = max(group.expected_members, expected_members)

            group.active_members.add(member_id)
            group.ready_members.add(member_id)
            if not group.released and len(group.ready_members) >= group.expected_members:
                group.released = True
                group.release_event.set()

            release_event = group.release_event
            was_already_released = group.released

        if not was_already_released:
            await release_event.wait()
            return True

        return False

    async def unregister_member(
        self,
        session_id: str,
        member_id: str,
    ) -> None:
        """Remove a member and release any waiting formation if needed."""

        if not session_id:
            return

        async with self._lock:
            group = self._groups.get(session_id)
            if group is None:
                return

            if member_id in group.active_members:
                group.active_members.remove(member_id)
                if not group.released:
                    group.expected_members = max(0, group.expected_members - 1)

            group.ready_members.discard(member_id)

            if not group.released and group.expected_members > 0 and len(group.ready_members) >= group.expected_members:
                group.released = True
                group.release_event.set()

            if not group.active_members:
                self._groups.pop(session_id, None)
