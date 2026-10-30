"""Run every source-owned Python bridge and analysis-efficiency test."""

from pathlib import Path
import json
import subprocess
import sys
import unittest

root = Path(__file__).resolve().parent.parent
REQUIRED_BRIDGE_FAMILIES = ("mitmproxy", "native", "pwndbg")


def fail(code, **details):
    print(json.dumps({"code": code, **details}, sort_keys=True), file=sys.stderr)
    raise SystemExit(1)


class BridgeResult(unittest.TextTestResult):
    """Count cases that actually started and did not skip in each family."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started = {family: set() for family in REQUIRED_BRIDGE_FAMILIES}
        self.skipped_cases = {family: set() for family in REQUIRED_BRIDGE_FAMILIES}

    @staticmethod
    def family(test):
        parts = test.id().split(".")
        if len(parts) > 2 and parts[0] == "bridge":
            return parts[1]
        return None

    def startTest(self, test):
        family = self.family(test)
        if family in self.started:
            self.started[family].add(test.id())
        super().startTest(test)

    def addSkip(self, test, reason):
        family = self.family(test)
        if family in self.skipped_cases:
            self.skipped_cases[family].add(test.id())
        super().addSkip(test, reason)


def run_bridge(modules):
    # The script directory is sys.path[0]; imports must resolve from the checkout.
    sys.path.insert(0, str(root))
    suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
    result = unittest.TextTestRunner(verbosity=2, resultclass=BridgeResult).run(suite)
    missing = [
        family
        for family in REQUIRED_BRIDGE_FAMILIES
        if not result.started[family] - result.skipped_cases[family]
    ]
    if missing:
        fail("no_executed_bridge_tests", families=missing)
    if not result.wasSuccessful():
        raise SystemExit(1)


bridge_root = root / "bridge"
bridge_tests = sorted(
    path for path in bridge_root.rglob("test_*.py") if path.is_file()
)
families = {path.relative_to(bridge_root).parts[0] for path in bridge_tests}
missing_families = [
    family for family in REQUIRED_BRIDGE_FAMILIES if family not in families
]
if missing_families:
    fail("missing_bridge_family", families=missing_families)
if not list(root.joinpath("tests/support/analysis-efficiency").glob("test_*.py")):
    fail("missing_analysis_efficiency_tests")
modules = [
    ".".join(path.relative_to(root).with_suffix("").parts) for path in bridge_tests
]
if sys.argv[1:] == ["--bridge"]:
    run_bridge(modules)
    raise SystemExit(0)
if sys.argv[1:]:
    fail("invalid_python_test_arguments")
bridge_result = subprocess.run(
    [sys.executable, __file__, "--bridge"], cwd=root, check=False
)
if bridge_result.returncode:
    sys.exit(bridge_result.returncode)
result = subprocess.run(
    [
        sys.executable, "-m", "unittest", "discover",
        "-s", "tests/support/analysis-efficiency", "-p", "test_*.py", "-v",
    ],
    cwd=root,
    check=False,
)
if result.returncode:
    sys.exit(result.returncode)
