# Per-call source-map budget recovery

## Problem

Local tracing and bundle source-map collection discard or refuse useful facts
at independent fixed byte, structural and codec-heap ceilings. A longer timeout
cannot admit the same map. Related: #6176, #8434, #8978.

## Requirements

- Preserve defaults unless representative calibration justifies a change;
  preserve selected artifact identities, source declarations,
  unknown coverage and cleanup ownership.
- Admit explicit bounded per-call budgets at the producing owners, and propagate
  the same policy through acquisition, structural preflight, codec child and
  complete request/reply checks.
- Reject inapplicable fields; preserve omission in Evidence parameters.
- Explain the exact exhausted control, effective value, range, application point
  and recovery. Retain real representation and client constraints.
- Keep upstream decoding unchanged and preflight rows/segments before allocation.

## Acceptance

A valid local map fails at an explicitly lowered admission, names map_bytes,
and succeeds for the same point through the public CLI after increasing that
budget. The 8 MiB default admits a complete map above 4 MiB while
preserving an explicit smaller selection.
A finite fetched map similarly recovers after increasing decoded_records.
Malformed maps, cancellation and failed cleanup retain their existing semantics.

## Non-goals

No source fetching beyond existing origin authority, application execution,
implicit retries, unbounded allocation or change to client deadlines.
