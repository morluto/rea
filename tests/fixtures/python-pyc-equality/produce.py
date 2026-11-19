"""Regenerate with CPython 3.12.14: python3 -I -S produce.py [--check].

Only compile, replace, serialize, and load inert code objects; never execute them.
Marshal v0 avoids reference sharing, so every retained member is a distinct object.
Two-member frozensets are framed before loading: constructing a Python frozenset
first would deduplicate the inputs and conceal the behavior being tested.
"""
import base64
import hashlib
import importlib.util
import json
import marshal
import struct
import sys
from pathlib import Path

if sys.implementation.name != "cpython" or sys.version_info[:3] != (3, 12, 14):
    raise SystemExit("This recorded oracle requires CPython 3.12.14.")

base = compile("def f(a, b):\n return a + b\n", "equality.py", "exec").co_consts[0]
handler = compile(
    "def f(a, b):\n try: return a / b\n except ZeroDivisionError: return None\n",
    "equality.py",
    "exec",
).co_consts[0]
cases = [
    ("qualified name is ignored", base, base.replace(co_qualname="other.f")),
    ("stack size is ignored", base, base.replace(co_stacksize=base.co_stacksize + 1)),
    ("line table distinguishes members", base, base.replace(co_linetable=b"")),
    ("exception table distinguishes members", handler, handler.replace(co_exceptiontable=b"")),
    (
        "first line distinguishes members",
        base,
        base.replace(co_firstlineno=base.co_firstlineno + 1),
    ),
    (
        "bool and int constants stay distinct",
        base.replace(co_consts=(True,)),
        base.replace(co_consts=(1,)),
    ),
    (
        "int and float constants stay distinct",
        base.replace(co_consts=(1,)),
        base.replace(co_consts=(1.0,)),
    ),
    (
        "signed zero constants stay distinct",
        base.replace(co_consts=(0.0,)),
        base.replace(co_consts=(-0.0,)),
    ),
]


def frozen_pair(left, right):
    return b">" + struct.pack("<i", 2) + marshal.dumps(left, 0) + marshal.dumps(right, 0)


marker = (b"REA code-equality producer placeholder",)
module = compile("pass", "equality-root.py", "exec").replace(co_consts=marker)
serialized = marshal.dumps(module, 0)
assert serialized.count(marshal.dumps(marker, 0)) == 1
payload = b"(" + struct.pack("<i", len(cases))
payload += b"".join(frozen_pair(left, right) for _, left, right in cases)
serialized = serialized.replace(marshal.dumps(marker, 0), payload)
loaded = marshal.loads(serialized)
expected = []
for (label, left, right), members in zip(cases, loaded.co_consts, strict=True):
    assert isinstance(members, frozenset)
    # CPython's code equality and the independently loaded container must agree.
    assert len(members) == (1 if left == right else 2)
    expected.append({"label": label, "members": len(members)})
blob = importlib.util.MAGIC_NUMBER + bytes(12) + serialized
result = {
    "producer": "CPython 3.12.14, marshal version 0",
    "sha256": hashlib.sha256(blob).hexdigest(),
    "pyc_base64": base64.b64encode(blob).decode("ascii"),
    "cases": expected,
    "code_objects": 1 + sum(case["members"] for case in expected),
}
path = Path(__file__).with_name("golden.json")
if sys.argv[1:] == ["--check"]:
    assert json.loads(path.read_text()) == result, "Golden differs from CPython producer"
    print(f"CPython oracle matches {len(cases)} cases; bytecode was not executed.")
elif not sys.argv[1:]:
    path.write_text(json.dumps(result, indent=2) + "\n")
else:
    raise SystemExit("Usage: produce.py [--check]")
