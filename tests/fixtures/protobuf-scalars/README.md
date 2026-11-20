# Protobuf scalar wire oracle

`oracle.json` was produced by Python's official `protobuf==6.33.5`, independently
of REA and its `@bufbuild/protobuf` decoder. The passive messages cover all 13
packable scalar types, including signed minima, unsigned maxima, values above
JavaScript's exact integer range, ZigZag boundaries, and floating negative zero.
No captured traffic or target execution is involved.

The producer serializes each repeated field with packing enabled and disabled.
Both messages are then parsed by both descriptor variants with the Python
runtime, checking the same semantic values in all four combinations. Protobuf
parsers must accept either wire form regardless of the schema's packing option:
<https://protobuf.dev/programming-guides/encoding/#packed>.

The expected semantic strings come from the independently decoded Python fields.
A small Python wire walk records each occurrence's exact offsets, lengths and raw
unsigned bits. It does not use REA or its JavaScript dependency. The CLI/MCP test
compares these facts, body hashes and the selected descriptor hash, rather than
only comparing the two REA adapters to each other. Python is not needed to run
that regression.

To reproduce using Python 3.12:

```sh
python -m venv /tmp/rea-protobuf-oracle
/tmp/rea-protobuf-oracle/bin/pip install protobuf==6.33.5
/tmp/rea-protobuf-oracle/bin/python tests/fixtures/protobuf-scalars/producer.py --check
```

To regenerate intentionally, omit `--check` and inspect the changed oracle.
The fixture qualifies scalar interpretation and occurrence provenance; it does
not qualify a real network transport, schema authentication, unsupported maps or
extensions. Current production decoding is correct for these samples.

Mutation qualification at main `54906fdb1`: changing the `sint64` annotation to
read ordinary `int64` left all 89 tests in the nine existing Protobuf suites
passing. This public-boundary regression failed on the signed values (for
example, ZigZag `1` became `1` instead of `-1`). The mutation was restored and
the original production file's SHA-256 verified before final qualification.
