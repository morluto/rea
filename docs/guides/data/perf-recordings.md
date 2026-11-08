# Linux perf recordings

`inspect_perf_data` / `inspect-perf-data` inventories one explicitly selected
Linux `perf.data` recording without a Linux host, a `perf` installation or the
recorded process. Use it to establish what a recording contains before relying
on it for process investigations.

```sh
rea inspect-perf-data ./perf.data --json
rea inspect-perf-data ./perf.data --max-events 500 --evidence-output ./perf-inventory.json
```

```json
{
  "name": "inspect_perf_data",
  "arguments": {
    "path": "/artifacts/perf.data",
    "max_events": 500
  }
}
```

MCP paths must be absolute filesystem paths on the current host. CLI paths
resolve against the operator's working directory. Nothing outside the selected
file is read and `perf` is never executed: importing a recording does not
contact the recorded host, launch the recorded process, or replay its samples.

## Returned evidence

The inventory reports:

- the file header: `PERFILE2` magic, byte order, declared header extent and the
  writer's attribute entry stride;
- the attribute and data section extents the header declares, with a
  `within_file` flag so an out-of-range extent is visible rather than clamped;
- one row per event attribute group, in file order, with `type`, `config`,
  `sample_type`, `read_format`, the declared sample period or frequency, the
  `sample_freq` flag that says which unit applies, the attribute size and the
  event identifiers read from the entry's id array;
- typed diagnostics for a missing magic, a truncated or unsupported header, an
  out-of-range or overlapping attribute section, an unusable attribute stride,
  a truncated entry, or an id array that is not a whole number of in-file
  identifiers.

Both byte orders are accepted: the magic reads `PERFILE2` in the recording
host's order, and `file_header.byte_order` states which one was used. The two
header layouts `perf` writes are distinguished by
`file_header.feature_bitmap`.

## What this step does not do

Feature payloads and sample records are not decoded. Callchains, sampled
instruction addresses, module build identities and symbol names are therefore
absent, and `source_coverage` states those gaps explicitly. Sample periods and
frequencies are the recording's declared sampling settings; they are not an
execution count, CPU time, or evidence that a function ran.

`summary.identifiers_present` is `false` when any entry's id array could not be
read as declared, so a smaller `summary.identifiers` is not mistaken for a
complete identifier inventory in that case.

## Limits

A single recording is admitted up to 64 MiB and 20 000 event attribute groups.
These are resource allowances, not format limits. A recording that exceeds the
event allowance reports `event-limit-reached` and keeps the groups it already
read; `source_coverage.status` becomes `partial`.
