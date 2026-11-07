# Offline OTLP traces

Use `inspect_otlp_trace` or `inspect-otlp-trace` with an existing local
**OTLP JSON** trace export. Import is offline: REA never contacts a collector or
observability backend, fetches linked resources, or executes the recorded
application.

```sh
rea inspect-otlp-trace /absolute/traces.json --json
rea inspect-otlp-trace /absolute/traces.json --detail summary \
  --evidence_output /absolute/new-evidence.bundle.json --json
```

Only the OTLP JSON encoding is decoded. Protobuf exports are not supported, and
selecting one fails as an input-format error rather than being guessed at.

## What is retained

Each recorded span keeps its trace, span and parent identifiers, name, kind,
status, start and end timestamps as exact 64-bit decimal strings, the
its own attributes, and indexes into the `resources` and `scopes` arrays. Each
resource stores `service.name` and resource attributes once; each scope stores
its name, version, and resource index. Group source pointers preserve their
positions in the input. Event and link counts are reported without their payloads.

- **Identity is recorded, not reconstructed.** A parent identifier the export
  does not contain is reported in `orphan_span_ids` with a `missing-parent`
  diagnostic. Its children stay parented to an unrecorded span and are not
  promoted to roots. An invalid parent retains its original JSON value in
  `parent_span_id_raw` and has `parent_span_id_state: "invalid"`; missing and
  zero-value parent IDs have state `absent`. `roots` lists only spans that declare no parent at all, so a
  captured subtree is never presented as a complete one.
- **Duplicates and cycles stay visible.** A repeated span identifier retains both
  records with a `duplicate-span-id` diagnostic, and a parent cycle is reported as
  `cycle` instead of producing an ordering.
- **Timing stays raw.** `duration_nano` is derived only when the recorded
  interval is non-negative; a reversed interval keeps both timestamps and adds an
  `invalid-time-interval` diagnostic. Clock domains and skew are not corrected.
- **Unreadable integers stay recorded.** A timestamp outside uint64 or an
  `intValue` outside int64 leaves the exact-value field null and keeps the
  recorded JSON in `start_time_unix_nano_raw`, `end_time_unix_nano_raw` or
  `int_value_raw`, so damage is never reported as an omitted value. If a rejected
  value cannot be represented within the Evidence JSON depth limit, the import
  fails with the completed file identity instead of dropping that value. A
  numeric 64-bit field whose JSON number cannot be admitted exactly is also
  refused with the file identity, rather than returning a rounded value. Numeric
  spellings longer than 256 characters are refused before exactness checking;
  recorded decimal strings are preserved within the file-size allowance. Source
  coordinates for at most 16,384 imprecise numeric fields are retained; an
  export exceeding that memory bound fails with the verified file identity.
  Array and key-value-list contents are counted without scanning their numbers.
- **Attributes are bounded.** Scalar attribute values are preserved as recorded,
  including values whose keys resemble credentials. A `doubleValue` the schema
  cannot hold as a finite JavaScript number — the OTLP spellings `"NaN"`,
  `"Infinity"` and `"-Infinity"`, or an overflowed exponent — keeps the recorded
  JSON in `double_value_raw`. Array and key-value-list
  attributes report only their element count. Each span and resource retains at
  most 128 attributes; omissions are reported in diagnostics or limitations.
  Resource and scope groups are retained when at least one span is inventoried.

## Coverage

`source_coverage` states what the import does not establish: recording
completeness is unknown, the live collector is not contacted, protobuf encodings
are unsupported and clock skew is not corrected. An absent span never proves that
an operation did not occur.

File admission is 32 MiB by default (`max_file_bytes`) and the export-level span
allowance is 50,000. Exceeding either is reported as a diagnostic and as a
limitation; it never silently shortens the inventory without saying so.

Diagnostics retain the first 1000 findings in processing order, sorted by ID
for display. If more occur, a limitation gives the omitted count; later findings
are counted without retaining or hashing them.
