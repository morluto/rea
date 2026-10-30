"""Run every source-owned Python bridge and analysis-efficiency test."""

from pathlib import Path
import json
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
# The previous explicit command named these families. Discovery still runs
# every bridge test, and each named family must keep a test module.
REQUIRED_BRIDGE_FAMILIES = ("mitmproxy", "native", "pwndbg")


def fail(code, **details):
    print(json.dumps({"code": code, **details}, sort_keys=True), file=sys.stderr)
    raise SystemExit(1)


def family_tests(family):
    return [
        path
        for path in root.joinpath("bridge", family).rglob("test_*.py")
        if path.is_file()
    ]


missing_families = [
    family for family in REQUIRED_BRIDGE_FAMILIES if not family_tests(family)
]
if missing_families:
    fail("missing_bridge_family", families=missing_families)
bridge_tests = sorted(root.joinpath("bridge").rglob("test_*.py"))
if not bridge_tests:
    fail("missing_bridge_tests")
if not list(root.joinpath("tests/support/analysis-efficiency").glob("test_*.py")):
    fail("missing_analysis_efficiency_tests")
modules = [
    ".".join(path.relative_to(root).with_suffix("").parts) for path in bridge_tests
]
commands = [
    [sys.executable, "-m", "unittest", "-v", *modules],
    [
        sys.executable, "-m", "unittest", "discover",
        "-s", "tests/support/analysis-efficiency", "-p", "test_*.py", "-v",
    ],
]
for command in commands:
    result = subprocess.run(command, cwd=root, check=False)
    if result.returncode:
        sys.exit(result.returncode)
