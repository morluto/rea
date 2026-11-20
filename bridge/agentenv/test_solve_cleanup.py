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
        self.folder = self.root / "agent-env-local-a1b2c3d4-abcdef12"
        self.folder.mkdir()
        self.terminated = []
        self.module = types.ModuleType("agent_env.providers.sandbox_providers.local_docker.provider")
        test = self

        class Provider:
            async def terminate_sandbox(self, sandbox_id):
                test.terminated.append(sandbox_id)

        self.module.LocalSandboxProvider = Provider
        self.module.local_sandbox_ids = self._listed
        self.module.remove_local_work_dir = lambda sandbox_id: self._remove(sandbox_id)
        self.module._marked_pids = lambda _sandbox_id: []
        self.patch_module = patch.dict("sys.modules", {self.module.__name__: self.module})
        self.patch_module.start()
        self.addCleanup(self.patch_module.stop)

    def _listed(self):
        # As agentenv lists them: `agent-env-<id>-<suffix>` folders, whatever the id's shape.
        found = set()
        for entry in self.root.iterdir():
            sandbox_id, _, suffix = entry.name.removeprefix("agent-env-").rpartition("-")
            if entry.name.startswith("agent-env-") and sandbox_id and suffix and entry.is_dir():
                found.add(sandbox_id)
        return sorted(found)

    def _remove(self, sandbox_id):
        folder = next(self.root.glob(f"agent-env-{sandbox_id}-*"))
        folder.rmdir()
        return folder

    def run_cleanup(self):
        asyncio.run(solve_cleanup.cleanup(self.root))

    def test_terminates_owned_sandbox_before_removing_its_folder(self):
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            self.run_cleanup()
        self.assertEqual(self.terminated, ["local-a1b2c3d4"])
        self.assertFalse(self.folder.exists())

    def test_retains_folder_when_docker_reports_container_then_retries(self):
        with patch.object(solve_cleanup, "_docker", return_value="still-running"), patch.object(solve_cleanup.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "still has its agent container"):
                self.run_cleanup()
        self.assertTrue(self.folder.exists())
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            self.run_cleanup()
        self.assertFalse(self.folder.exists())
        self.assertEqual(len(self.terminated), 2)

    def test_partial_cleanup_and_late_folder_are_retried(self):
        later = self.root / "agent-env-local-f1223344-abcdef12"
        later.mkdir()
        def docker(*args):
            return "still-running" if "local-f1223344" in " ".join(args) else ""
        with patch.object(solve_cleanup, "_docker", side_effect=docker), patch.object(solve_cleanup.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "still has its agent container"):
                self.run_cleanup()
        self.assertTrue(later.exists())
        self.assertFalse(self.folder.exists())
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            self.run_cleanup()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_macos_keeps_folder_when_host_process_cleanup_cannot_be_verified(self):
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "Cannot verify host processes"):
                self.run_cleanup()
        self.assertTrue(self.folder.exists())

    def test_cleans_up_each_sandbox_agentenv_lists_whatever_its_id_looks_like(self):
        self.folder.rmdir()
        listed = self.root / "agent-env-local-a1b2c3d4e5-abcdef12"
        listed.mkdir()
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            self.run_cleanup()
        self.assertEqual(self.terminated, ["local-a1b2c3d4e5"])
        self.assertFalse(listed.exists())

    def test_unexpected_entry_remains_owned(self):
        self.folder.rmdir()
        (self.root / "unexpected").mkdir()
        with patch.object(solve_cleanup, "_docker", return_value=""), patch.object(solve_cleanup.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "Unexpected sandbox root entries: unexpected"):
                self.run_cleanup()
        self.assertEqual(self.terminated, [])
        self.assertTrue((self.root / "unexpected").exists())


if __name__ == "__main__":
    unittest.main()
