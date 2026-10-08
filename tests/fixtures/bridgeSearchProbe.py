"""Exercise REA's bridge inventory search without starting a Hopper socket."""

import json
from pathlib import Path
import sys


def _load_bridge(path):
    source = Path(path).read_text(encoding="utf-8")
    namespace = {"__file__": path, "__name__": "rea_hopper_bridge"}
    exec(compile(source, path, "exec"), namespace)
    return namespace


def _probe(namespace, payload):
    action = payload["action"]
    try:
        if action == "search":
            inventory = tuple(tuple(item) for item in payload["items"])
            namespace["_search_inventory"] = lambda _document, _kind: inventory
            # String hits are joined with typed records. The package check supplies
            # those records so it can run the packed matcher without a Hopper document.
            namespace["_string_inventory"] = lambda _document: {
                address: {"value": value} for address, value in inventory
            }
            return {
                "action": action,
                "ok": True,
                "result": namespace["_search_results"](
                    object(), "string", payload["params"]
                ),
            }
        raise ValueError("unknown probe action")
    except Exception as error:
        return {
            "action": action,
            "ok": False,
            "type": type(error).__name__,
            "diagnostic_type": namespace["_diagnostic_type"](error),
            "message": str(error),
        }


if __name__ == "__main__":
    bridge = _load_bridge(sys.argv[1])
    if len(sys.argv) >= 3:
        print(json.dumps(_probe(bridge, json.loads(sys.argv[2])), sort_keys=True))
    else:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            print(json.dumps(_probe(bridge, request), sort_keys=True), flush=True)
