# Tasks

- [x] Define single-feature scope, contracts, and implementation plan (`spec.md`, `plan.md`).
- [x] Add `"android_ident"` type name mapping and nullable `android` schema on `elfNotesSchema` (`src/domain/native/elfNotes.ts`).
- [x] Implement endian-aware `decodeAndroid` with printable-ASCII / zero-padding validation and `TextBudget` scan/used accounting (`src/native/elf/ElfNoteParser.ts`).
- [x] Update `inspect_elf_notes` contract metadata (`src/contracts/native/binaryDiagnosticsToolContracts.ts`).
- [x] Add domain, parser, MCP boundary, and CLI/stdio-MCP acceptance tests (`elfNotes.test.ts`, `ElfNoteParser.test.ts`, `elfNotesMcp.test.ts`, `elfNotesAndroid.test.ts`).
- [x] Update `docs/elf-notes.md` and `docs/specs/README.md`; pass all verification gates.
