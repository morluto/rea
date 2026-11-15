"""Compile advertised schemas with the engines and validators clients use.

Reads ``{"patterns": [...], "schemas": [...], "complete": bool}`` as JSON
from the file named by the first argument and writes one result per engine or
validator as JSON on stdout. Pattern results index ``patterns``; schema results
index ``schemas``. A package that is not installed is reported as unavailable,
never as passing; the caller decides whether that is allowed. ``complete`` adds
the slow Python ``jsonschema`` meta-validation. Run with ``python3 -I`` so
nothing is imported from the working directory.
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
    with open(sys.argv[1], encoding="utf-8") as request_file:
        request = json.load(request_file)
    patterns = request["patterns"]
    schemas = request["schemas"]
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
                unavailable("rust jsonschema", "schema", reason),
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
        # Default construction, as a Rust client builds a validator: the
        # declared draft's meta-schema, its formats and every subschema.
        results.append(
            check(
                "rust jsonschema",
                "schema",
                version,
                jsonschema_rs.validator_for,
                schemas,
            )
        )

    if request.get("complete"):
        try:
            import jsonschema
        except ImportError as error:
            results.append(
                unavailable(
                    "python jsonschema", "schema", f"jsonschema is not installed: {error}"
                )
            )
        else:
            # Python MCP clients validate structured results with
            # `jsonschema.validate`, which first checks the schema against its
            # declared draft's meta-schema, including the `regex` format.
            results.append(
                check(
                    "python jsonschema",
                    "schema",
                    distribution_version("jsonschema"),
                    lambda schema: jsonschema.validators.validator_for(
                        schema
                    ).check_schema(schema),
                    schemas,
                )
            )

    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
