"""Exercise the capture controller's filesystem inventory boundary."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CONTROLLER = Path(__file__).with_name("capture.py")


class CaptureListingTest(unittest.TestCase):
    def run_listing(self, root, output):
        return subprocess.run(
            [
                sys.executable,
                str(CONTROLLER),
                "list",
                json.dumps({"root": str(root), "output": str(output)}),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_directory_symlink_is_disclosed_without_following_it(self):
        with tempfile.TemporaryDirectory() as parent:
            parent = Path(parent)
            root = parent / "root"
            target = parent / "target"
            output = parent / "listing.json"
            root.mkdir()
            target.mkdir()
            (root / "present.txt").write_text("present")
            (target / "outside.txt").write_text("outside")
            try:
                (root / "linked").symlink_to(target, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlinks unavailable: {error}")
            result = self.run_listing(root, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            listing = json.loads(output.read_text())
            self.assertEqual(
                [item["path"] for item in listing["files"]],
                [os.path.relpath(root / "present.txt", Path.home())],
            )
            self.assertEqual(
                listing["skipped"], [os.path.relpath(root / "linked", Path.home())]
            )

    def test_missing_root_does_not_produce_an_empty_successful_inventory(self):
        with tempfile.TemporaryDirectory() as parent:
            parent = Path(parent)
            output = parent / "listing.json"
            result = self.run_listing(parent / "missing", output)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
