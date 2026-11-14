# Implementation plan

This plan records the design that [#7486](https://github.com/morluto/rea/pull/7486)
implements, written on 14 November 2026 from that implementation.

## Boundary and contract

- **Family.** `elfArchitecture` in `src/domain/elfFixedHeader.ts` maps
  machine 94 to `xtensa`, which joins `ELF_METADATA_ARCHITECTURES` in
  `src/domain/binaryTargetTypes.ts`; `src/domain/binaryTarget.ts` keeps the
  target's ELF header facts as `XtensaElfMetadata`.
- **Declarations.** `readElfMetadata` in `src/application/BinaryTargetResolver.ts`
  calls `readXtensaElfInfo` (`src/application/XtensaElfMetadata.ts`) on the
  admitted descriptor. It reads the declared tables through
  `readElfTableDeclarations`, decodes the section-name table once through
  `decodeElfSectionNameTable`, streams section headers in 64 KiB batches and
  keeps only the `.xtensa.info` match. `parseXtensaInfo`
  (`src/domain/xtensaInfo.ts`) frames the notes with the shared ELF note layout
  (`src/domain/native/elfNoteLayout.ts`), which `inspect_elf_notes` also uses,
  and reads the `ABI=` and `USE_ABSOLUTE_LITERALS=` keys.
- **Gate and pin.** `src/ghidra/GhidraXtensaProfile.ts` owns admission
  (`ghidraXtensaUnsupportedReason`), the pinned language
  (`ghidraXtensaLanguage`), the profile parameters `xtensa_elf` and
  `xtensa_support_lane: elf32-le-exec-windowed-generic-v1`, the limitations and
  the post-import check (`ghidraXtensaProfileMismatchReason`).
  `GhidraAnalysisProfile.ts` selects the pin, and `GhidraProviderClient.ts`
  fails a session whose imported language or compiler specification differs
  and adds the lane's limitations.
- **Compatibility.** The `xtensa` value is additive in three closed output enums
  (Evidence subject, snapshot target, live target summary); the PR asks the
  maintainers to decide on it (C1). No tools, inputs, bridge or package
  changes.

## Verification

`scripts/verify-real-ghidra-xtensa.mjs` with `tests/conformance/ghidra/xtensa-fixture.mjs`
and `xtensa-checks.mjs` runs the real-Ghidra lane; `tests/conformance/c/xtensa.c`
is the optional compiled fixture. The lane guide,
[Xtensa ELF analysis through Ghidra](../../../providers/ghidra-xtensa.md), owns
the user-facing description and measured costs.

## Effects

Target resolution reads only the admitted descriptor within explicit bounds. No
new processes, network access or writes.
