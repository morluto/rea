"""Compile the shipped extension with controlled API doubles and run its transaction contract.

Requires JAVA_HOME (JDK 21+) and GSON_JAR. This does not validate real Ghidra APIs.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
JAVA = Path(os.environ['JAVA_HOME']) / 'bin'
GSON = os.environ['GSON_JAR']
with tempfile.TemporaryDirectory(prefix='rea-nativeaot-java-') as temp:
    root = Path(temp)
    sources = [str(p) for p in (Path(__file__).parent / "stubs").rglob("*.java")]
    sources += [os.environ.get("REA_NATIVEAOT_PRODUCER_SOURCE", str(ROOT / "bridge/nativeaot/NativeAotExtension.java")), str(Path(__file__).with_name('NativeAotProducerProbe.java'))]
    subprocess.run([str(JAVA / 'javac'), '--release', '21', '-cp', GSON, '-d', str(root), *sources], check=True, timeout=30)
    subprocess.run([str(JAVA / 'java'), '-cp', os.pathsep.join([str(root), GSON]), 'rea.extensions.nativeaot.NativeAotProducerProbe', *sys.argv[1:]], check=True, timeout=30)
