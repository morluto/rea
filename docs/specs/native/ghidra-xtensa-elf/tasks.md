# Tasks

Recorded on 14 November 2026 from the work in
[#7486](https://github.com/morluto/rea/pull/7486); each item is on the PR branch.

- [x] Resolve machine 94 as the `xtensa` family with its ELF header facts (`elfFixedHeader.ts`, `binaryTargetTypes.ts`, `binaryTarget.ts`, `binaryTarget.test.ts`).
- [x] Read `.xtensa.info` during target resolution and leave both declarations unknown for every unreadable or malformed case (`XtensaElfMetadata.ts`, `xtensaInfo.ts`, `xtensaInfo.test.ts`, `tests/boundary/filesystem/xtensaAbiDeclaration.test.ts`).
- [x] Share the ELF note layout with `inspect_elf_notes`, padding notes by the section's declared alignment (`elfNoteLayout.ts`, `ElfNoteParser.ts`, `elfNoteLayout.test.ts`).
- [x] Stream section headers in 64 KiB batches and name the fixed bounds in refusals (`XtensaElfMetadata.ts`; boundary tests for a 60,000-section table and the name-scan budget).
- [x] Gate the Ghidra lane, pin `Xtensa:LE:32:default` with `default`, and check the imported identity (`GhidraXtensaProfile.ts`, `GhidraXtensaProfile.test.ts`, `GhidraAnalysisProfile.ts`, `GhidraProviderClient.ts`).
- [x] Spell machine 94 `xtensa` in output enums and Go and Rust reports (`tests/acceptance/nativeElfArchitecture.test.ts`, `tests/boundary/mcp/liveBinaryTargetSummary.test.ts`).
- [x] Add the real-Ghidra lane and fixtures (`scripts/verify-real-ghidra-xtensa.mjs`, `tests/conformance/ghidra/xtensa-*.mjs`, `xtensa-checks.test.ts`, `tests/conformance/c/xtensa.c`); `verify:ghidra:xtensa` passes on Ghidra 12.1.4.
- [x] Document the lane (`docs/providers/ghidra-xtensa.md`) and index this specification (`docs/specs/README.md`).
