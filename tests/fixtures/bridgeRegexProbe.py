"""Execute REA's bridge regex helpers without starting a Hopper socket."""

import json
from pathlib import Path
import sys


def _load_bridge(path):
    source = Path(path).read_text(encoding="utf-8")
    prefix, marker, suffix = source.rpartition("\n_run()")
    if not marker or suffix.strip():
        raise RuntimeError("bridge entrypoint shape changed")
    namespace = {"__file__": path}
    exec(compile(prefix, path, "exec"), namespace)
    return namespace


def _probe(namespace, payload):
    action = payload["action"]
    try:
        if action == "match":
            parsed = namespace["sre_parse"].parse(payload["pattern"])
            paths, steps = namespace["_validate_regex_node"](parsed)
            flags = (
                0
                if payload.get("case_sensitive", False)
                else namespace["re"].IGNORECASE
            )
            expression = namespace["re"].compile(payload["pattern"], flags)
            matcher = namespace["_bounded_regex_matcher"](expression, paths, steps)
            matched = matcher(payload["value"])
            return {
                "action": action,
                "ok": True,
                "backtracking_paths": paths,
                "matched": matched,
            }
        if action == "search":
            inventory = tuple(tuple(item) for item in payload["items"])
            namespace["_search_inventory"] = lambda _document, _kind: inventory
            return {
                "action": action,
                "ok": True,
                "result": namespace["_search_page"](
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
    request = json.loads(sys.argv[2])
    print(json.dumps(_probe(bridge, request), sort_keys=True))
