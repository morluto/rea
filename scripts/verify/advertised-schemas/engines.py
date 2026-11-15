"""Compile advertised regular expressions with the engines clients use.

Reads ``{"patterns": [...]}`` as JSON on stdin and writes one result per
engine as JSON on stdout; each failure indexes ``patterns``. A package that is
not installed is reported as unavailable, never as passing; the caller decides
whether that is allowed. Run with ``python3 -I`` so nothing is imported from
the working directory.
"""

import json
import re
import sys
import time
from importlib import metadata


def distribution_version(name):
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def check(engine, kind, version, compile_value, values):
    start = time.perf_counter()
    failures = []
    for index, value in enumerate(values):
        try:
            compile_value(value)
        except Exception as error:  # Each engine has its own error type.
            failures.append({"index": index, "error": str(error)})
    return {
        "engine": engine,
        "kind": kind,
        "version": version,
        "elapsed": round((time.perf_counter() - start) * 1000),
        "failures": failures,
    }


def unavailable(engine, kind, reason):
    return {"engine": engine, "kind": kind, "unavailable": reason}


def main():
    request = json.load(sys.stdin)
    patterns = request["patterns"]
    results = [
        check("python re", "pattern", sys.version.split()[0], re.compile, patterns)
    ]

    try:
        import re2
    except ImportError as error:
        results.append(
            unavailable("re2 (C++)", "pattern", f"google-re2 is not installed: {error}")
        )
    else:
        # Default options, as gateways embedding RE2 use them.
        results.append(
            check(
                "re2 (C++)",
                "pattern",
                distribution_version("google-re2"),
                lambda pattern: re2.compile(pattern, re2.Options()),
                patterns,
            )
        )

    try:
        import jsonschema_rs
    except ImportError as error:
        reason = f"jsonschema-rs is not installed: {error}"
        results.extend(
            [
                unavailable("rust regex", "pattern", reason),
                unavailable("rust fancy-regex", "pattern", reason),
            ]
        )
    else:
        version = distribution_version("jsonschema-rs")
        # The Rust `jsonschema` crate compiles each `pattern` with the selected
        # engine after translating ECMA-262 syntax, as Rust clients do.
        for engine, options in (
            ("rust regex", jsonschema_rs.RegexOptions),
            ("rust fancy-regex", jsonschema_rs.FancyRegexOptions),
        ):
            results.append(
                check(
                    engine,
                    "pattern",
                    version,
                    lambda pattern, options=options: jsonschema_rs.validator_for(
                        {"type": "string", "pattern": pattern},
                        validate_formats=False,
                        pattern_options=options(),
                    ),
                    patterns,
                )
            )

    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
