"""Exercise cleanup decisions without a live agentenv provider."""
import asyncio
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.agentenv import solve_cleanup


class SolveCleanupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folders = {}
        self.folder = self._add_sandbox("local-a1b2c3d4")
        self.events = []
        self.module = types.ModuleType("agent_env.providers.sandbox_providers.local_docker.provider")
        test = self

        class Provider:
            async def terminate_sandbox(self, sandbox_id):
                test.events.append(("terminate", sandbox_id))

        self.module.LocalSandboxProvider = Provider
        self.module.local_sandbox_ids = self._listed
        self.module.remove_local_work_dir = lambda sandbox_id: self._remove(sandbox_id)
        self.module._marked_pids = lambda _sandbox_id: []
        self.patch_module = patch.dict("sys.modules", {self.module.__name__: self.module})
        self.patch_module.start()
        self.addCleanup(self.patch_module.stop)

    def _add_sandbox(self, sandbox_id):
        folder = self.root / f"agent-env-{sandbox_id}-abcdef12"
        folder.mkdir()
        self.folders[sandbox_id] = folder
        return folder

    def _listed(self):
        return [sandbox_id for sandbox_id, folder in self.folders.items() if folder.is_dir()]

    def _remove(self, sandbox_id):
        self.events.append(("remove", sandbox_id))
        folder = self.folders[sandbox_id]
        folder.rmdir()
        return folder

    def run_cleanup(self):
        asyncio.run(solve_cleanup.cleanup(self.root))

    def test_terminates_before_removing_and_retries_only_the_retained_sandbox(self):
        blocked_id = "local-f1223344e5"
        blocked = self._add_sandbox(blocked_id)

        def docker(*args):
            return "still-running" if args[-1] == f"name=^agent-{blocked_id}$" else ""

        with patch.object(solve_cleanup, "_docker", side_effect=docker), patch.object(solve_cleanup.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "still has its agent container"):
                self.run_cleanup()
        self.assertFalse(self.folder.exists())
        self.assertTrue(blocked.exists())
        self.assertEqual(self.events, [
            ("terminate", "local-a1b2c3d4"),
            ("remove", "local-a1b2c3d4"),
            ("terminate", blocked_id),
        ])

        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            self.run_cleanup()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.events[-2:], [("terminate", blocked_id), ("remove", blocked_id)])
        self.assertEqual(len(self.events), 5)

    def test_macos_keeps_folder_when_host_process_cleanup_cannot_be_verified(self):
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "Cannot verify host processes"):
                self.run_cleanup()
        self.assertTrue(self.folder.exists())

    def test_unexpected_entry_remains_owned(self):
        self.folder.rmdir()
        (self.root / "unexpected").mkdir()
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "Unexpected sandbox root entries: unexpected"):
                self.run_cleanup()
        self.assertEqual(self.events, [])
        self.assertTrue((self.root / "unexpected").exists())


if __name__ == "__main__":
    unittest.main()
