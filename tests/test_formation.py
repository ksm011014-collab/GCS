from __future__ import annotations

import asyncio
import unittest

from backend.formation import FormationSyncManager


class FormationSyncManagerTests(unittest.TestCase):
    def test_wait_for_first_waypoint_release_blocks_until_expected_members_arrive(self) -> None:
        async def run_test() -> tuple[bool, bool]:
            manager = FormationSyncManager()
            await manager.register_member("session-a", "member-1", 2)
            await manager.register_member("session-a", "member-2", 2)

            first_task = asyncio.create_task(
                manager.wait_for_first_waypoint_release("session-a", "member-1", 2)
            )
            await asyncio.sleep(0)
            self.assertFalse(first_task.done())

            second_released = await manager.wait_for_first_waypoint_release("session-a", "member-2", 2)
            first_released = await first_task
            return first_released, second_released

        first_released, second_released = asyncio.run(run_test())

        self.assertTrue(first_released)
        self.assertFalse(second_released)

    def test_unregister_member_releases_remaining_waiters(self) -> None:
        async def run_test() -> bool:
            manager = FormationSyncManager()
            await manager.register_member("session-b", "member-1", 2)
            await manager.register_member("session-b", "member-2", 2)

            waiting_task = asyncio.create_task(
                manager.wait_for_first_waypoint_release("session-b", "member-1", 2)
            )
            await asyncio.sleep(0)
            await manager.unregister_member("session-b", "member-2")
            return await waiting_task

        released_after_unregister = asyncio.run(run_test())

        self.assertTrue(released_after_unregister)


if __name__ == "__main__":
    unittest.main()
