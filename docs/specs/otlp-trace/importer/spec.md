# Import a saved OTLP JSON trace export offline

Issue: https://github.com/morluto/rea/issues/8827

## Problem

REA inventories artifacts, packet captures and saved Playwright traces, but a
retained OpenTelemetry trace export had no importer. Parent/child span
structure, service and instrumentation-scope boundaries, and timing stayed
outside the Evidence model, so an analyst had to read the export by hand and
could not state what it does and does not establish.

## Desired behavior

`inspect_otlp_trace` (MCP) and `inspect-otlp-trace` (CLI) read one
caller-supplied OTLP **JSON** trace export and return retained Evidence. Import
is offline: REA never contacts a collector or observability backend, fetches a
linked resource, or runs the recorded application.

Only the OTLP JSON encoding is decoded. A protobuf export or a document that
carries another signal is rejected as an input-format error instead of being
guessed at.

## Requirements

- Span identity, name, kind, status, start and end timestamps, and the
  attributes the export records are retained. Timestamps stay exact 64-bit
  decimal strings.
- A parent the export does not contain is reported as an orphan with a
  `missing-parent` diagnostic. Its children stay parented to the unrecorded
  span rather than being promoted to roots, and `roots` lists only spans that
  declare no parent, so a captured subtree is never presented as complete.
- A repeated span identifier keeps both records with a `duplicate-span-id`
  diagnostic. A parent cycle is reported as `cycle` rather than producing an
  ordering.
- A duration is derived only from a non-negative recorded interval. Clock
  domains and skew are not corrected.
- A recorded value the schema cannot hold is preserved in its raw field instead
  of becoming an omitted value: an out-of-range timestamp or `intValue` in
  `start_time_unix_nano_raw`, `end_time_unix_nano_raw` or `int_value_raw`, and a
  non-finite `doubleValue` spelling in `double_value_raw`.
- Scalar attribute values are preserved as recorded, without inferring secrecy
  from a key name. Array and key-value-list attributes report only their element
  count.
- Resource and instrumentation-scope facts are retained once and referenced by
  index from each span and scope.
- `source_coverage` states what the import does not establish: recording
  completeness is unknown, the collector is not contacted, protobuf is
  unsupported, and clock skew is not corrected.

## Limits

File admission is 32 MiB by default and the export-level span allowance is
50,000; exceeding either is reported as a diagnostic and a limitation. Each span
and resource retains at most 128 attributes, and diagnostics retain the first
1000 findings in processing order.

## Acceptance

- A captured export yields spans with their resource and scope indexes, and an
  orphan, a duplicate identifier and a cycle each produce their diagnostic
  without an inferred replacement.
- A rejected integer, timestamp or double keeps its recorded JSON in the
  matching raw field.
- An absent span never proves that an operation did not occur, and that limit is
  stated in `source_coverage`.

## Non-goals

Protobuf decoding, critical-path derivation, correlation against HTTP or network
Evidence, metrics and logs signals, and retained-view paging over the inventory.
