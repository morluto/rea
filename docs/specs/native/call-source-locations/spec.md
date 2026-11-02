# Native call source coordinates

Issue: https://github.com/morluto/rea/issues/2382

## Problem and outcome

The existing bounded macOS LLDB call observation retains module, symbol and
addresses, but loses compiler-provided source coordinates. Retain line-entry
metadata at the same producer boundary for breakpoint locations, call entries
and caller frames.

## Requirements

- Add optional nullable source_location to the canonical native code location.
  A present object contains nullable file_path, line and column. Positive line
  and column values are one-based. Provider zero values mean unavailable.
- Preserve partial facts from a valid line entry. Invalid entries or entries
  without any usable facet produce null. Historical captures may omit the field.
- Read only SBAddress line metadata; do not resolve paths, read source contents,
  evaluate expressions or change the existing launch, stop or cleanup policy.
- The field establishes LLDB line-table attribution, not verified source bytes.
- Existing trace and breakpoint byte budgets include the new representation.

## Acceptance

Producer tests cover valid, invalid and partial entries, Unicode paths and absent
coordinates. Existing evidence without the field remains accepted. CLI/MCP and
partial retained-journal paths preserve the canonical field. The real native-call
verifier checks source coordinates for its owned debug build, including caller
frames and breakpoint locations, and reports actual host/provider coverage.

## Out of scope

New debugger adapters, interactive stepping, source breakpoints, source-file
association verification, source reads, Pascal/Delphi compatibility claims and
Java/Android/CLR runtime support.
