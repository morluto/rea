# Implementation plan

## Boundary and contract

Extend `ELF_NOTE_TYPE_NAMES`, `androidNoteTypeName`, and `elfNotesSchema` in
`src/domain/native/elfNotes.ts` with `"android_ident"` and nullable
`android: { android_api, ndk_version, ndk_build_number }` on each note entry.

Implement `scanAndroidIdentSlot` and `decodeAndroid` in
`src/native/elf/ElfNoteParser.ts`, invoked from `toEntry` alongside `decodeGnu`
and `decodeCore`. Cache the 128-byte fixed-slot scan per descriptor range under
`android:${byteOffset}:${length}` in `TextBudget.scans`, charge `scanned` once
per distinct range, and charge retained `ndk_version` and `ndk_build_number`
lengths to `TextBudget.used`. Update the `inspect_elf_notes` description in
`src/contracts/native/binaryDiagnosticsToolContracts.ts` and the owning guide
[ELF note tables](../../../elf-notes.md).

## Incremental work and validation

1. Extend `src/domain/native/elfNotes.ts` and add unit tests in
   `src/domain/native/elfNotes.test.ts`.
2. Add `androidIdentNote` fixture support in `src/native/elf/ElfNotes.fixture.ts`
   and implement `decodeAndroid` in `src/native/elf/ElfNoteParser.ts` with
   endianness, malformed-slot degradation, and `TextBudget` accounting tests in
   `src/native/elf/ElfNoteParser.test.ts`.
3. Add MCP boundary tests (`tests/boundary/mcp/elfNotesMcp.test.ts`) and
   CLI/stdio-MCP parity acceptance tests (`tests/acceptance/elfNotesAndroid.test.ts`)
   importing `BINARY_DIAGNOSTICS_TOOL_CONTRACTS`.
4. Update [ELF note tables](../../../elf-notes.md) and the feature specification
   index; pass formatting, static, typed-lint, test, and documentation gates.

## Effects and compatibility

`inspect_elf_notes` / `inspect-elf-notes` entries gain additive `"android_ident"`
and nullable `android` fields while preserving existing `gnu`, `core`, and
raw `descriptor` provenance. No external tools, network calls, or target
execution are introduced.
