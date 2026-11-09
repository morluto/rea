# Tasks

- [x] Define single-feature scope, contracts and implementation plan (`spec.md`, `plan.md`).
- [x] Define the DWARF unit report schema, limits and coverage states in `src/domain/native/dwarfUnits.ts`.
- [x] Locate and decompress ELF, Mach-O and PE debug sections, including the Mach-O `on_disk` file-range fact.
- [x] Decode abbreviations, framed units and unit DIEs with bounded `strx`, `DW_FORM_indirect` and relocation handling.
- [x] Register the MCP tool and CLI command; add provider, boundary, MCP and CLI acceptance tests.
- [x] Compare compiled fixtures with `llvm-dwarfdump` in `scripts/verify-dwarf-units.mjs` and record the run.
- [x] Add the DWARF compile units guide, CLI and README entries and skill guidance.
- [ ] Compare a GCC-produced object, a linked Mach-O image and a `.dSYM` DWARF file; the recorded run covered none of them.
