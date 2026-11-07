import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.agentenv import capture


class CaptureListingTest(unittest.TestCase):
    def test_lists_directory_symlinks_as_skipped_without_following_them(self):
        with tempfile.TemporaryDirectory(prefix="rea-capture-list-") as root:
            root_path = Path(root)
            (root_path / "plain.txt").write_bytes(b"x")
            output = root_path / "listing.json"
            folders = ["linked-dir", "ordinary-dir"]
            observed_folders = []

            def fake_walk(_root):
                yield str(root_path), folders, ["plain.txt"]
                observed_folders.append(folders.copy())

            def fake_islink(path):
                return str(path).endswith("linked-dir")

            with patch.object(capture.os, "walk", fake_walk), patch.object(
                capture.os.path, "islink", fake_islink
            ):
                capture.listing({"root": str(root_path), "output": str(output)})

            listed = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                [entry["path"] for entry in listed["files"]],
                [
                    os.path.relpath(
                        root_path / "plain.txt", os.path.expanduser("~")
                    )
                ],
            )
            self.assertEqual(
                listed["skipped"],
                [
                    os.path.relpath(
                        root_path / "linked-dir", os.path.expanduser("~")
                    )
                ],
            )
            self.assertEqual(observed_folders, [["ordinary-dir"]])


if __name__ == "__main__":
    unittest.main()
