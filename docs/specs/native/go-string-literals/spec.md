# Go static string-header literal recovery

## Problem and outcome

Go compilers pack static string contents contiguously in read-only sections
(`.rodata`, `__TEXT,__rodata` / `__TEXT,__const`, `.rdata`) without NUL
terminators. Generic C-string scans merge adjacent Go literals into multi-kilobyte
runs. Extend `inspect_go_binary` / `inspect-go-binary` with opt-in, bounded
`(ptr, len)` `reflect.StringHeader` recovery across ELF, PE and thin Mach-O
images so static string slices are recovered at their exact boundaries.

## Requirements

- Keep `include_string_literals` opt-in (`false` by default) so existing
  build-metadata output and payload size are unchanged unless requested.
- Scan only pointer-aligned non-executable initialized data spans (with indexed
  `O(log R)` readable segment checks on Mach-O and sectionless/unnamed-ELF
  load-region fallbacks) in deduplicated ascending file-offset order.
- Admit candidate `[ptr, ptr + len)` slices only inside single read-only
  non-executable mapped spans with `1 <= len <= 4096`, non-overlapping with the
  header itself, and valid printable UTF-8 (allowing `\t`, `\n`, `\r`, `U+200C`
  and `U+200D` while rejecting control, surrogate, noncharacter, private-use and
  invisible/bidi `\p{Cf}` code points).
- Bound header-scan work (`64 MiB`), tracked candidates (`100,000`), negative
  slice cache (`4,096`), returned items (`max_string_literals`, `1..10,000`,
  default `2,000`), and aggregate returned UTF-8 bytes (`512 KiB`), reporting
  `evidence_kind: "inferred"`, `discovered_count`, `aggregate_bytes` and
  `truncated` honestly.
- Record limitation notes when Mach-O `LC_DYLD_CHAINED_FIXUPS` encodes rebases in
  pointer slots or when truncation occurs, and expose a focused `string_literals`
  projection in `inspect_analysis_view`.

## Acceptance

Unit, boundary and CLI acceptance tests cover ELF/PE/Mach-O (32/64-bit, little
and big endian), sectionless and unreadable-`.shstrtab` ELF images, overlapping
spans, `U+200C`/`U+200D` versus disallowed `\p{Cf}` controls, negative-cache and
output caps, and 25,000-region Mach-O indexing/cancellation. The real Go binary
verifier validates CLI and advertised-schema MCP parity across compiled targets.

## Out of scope

Instruction-operand immediate string recovery (stack/register `MOV`/`LEA` pairs
without static two-word headers), Mach-O chained-fixup rebase decoding, binary
execution, and non-UTF-8 byte-slice guessing.
