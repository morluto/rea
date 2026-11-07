# Implementation plan

## Boundary and contract

- `src/domain/native/peRichHeader.ts` owns the input and report schemas. The
  report is a discriminated union on `state`. `padding` uses
  `fixedTupleSchema`.
- `src/native/pe/PeRichHeaderParser.ts` reuses `readPeHeaders` for PE
  admission. `e_lfanew` ends the search. The footer and `DanS` searches share
  one backward scan over aligned DWORDs that yields every 1 MiB.
- The checksum starts from the `DanS` offset. It adds each earlier byte rotated
  left by its offset modulo 32, skipping `e_lfanew` at `0x3C` to `0x3F`. It then
  adds each `@comp.id` rotated left by its count modulo 32, and keeps the low 32
  bits.
- `PeRichHeaderProvider` reads through `readStableArtifact`. It maps reader,
  format and budget failures to typed analysis errors, and retains the completed
  file identity on any later failure.
- `PeRichHeaderService` validates the report and creates Evidence for the record
  range, or only the footer when the record is malformed.
- CLI and MCP registration follow `inspect_pe_load_config` and
  `inspect_pe_certificates`. The tool's audited effect is read-only Evidence.

## Choices

- Take the last footer, not the first. A custom DOS stub can hold a whole PE
  image with its own record, as `tcblaunch.exe` does.
- Do not fix the `DanS` offset. Real drivers place it at `0x58` and `0x200`.
- Do not name product IDs. The mapping is undocumented and changes with each
  toolset.

## Incremental work and validation

1. Write parser tests on synthetic images with an independent BigInt checksum.
2. Implement the schema, parser, provider and service.
3. Wire the CLI, MCP, capability and tool-effect contracts. Add boundary tests.
4. Compare with pefile 2024.8.26 over installed Windows images and record the
   result.
5. Write the guide. Run focused, static and documentation checks.

## Effects and compatibility

Read-only and additive: one tool, one command and one `package.json` verify
script. No provider, dependency or target execution. Existing readers do not
change.

## References

- [PE Rich header guide](../../../pe-rich-header.md)
- [2026-11-04 verification record](../../../verification/pe-rich-header-2026-11-04.md)
