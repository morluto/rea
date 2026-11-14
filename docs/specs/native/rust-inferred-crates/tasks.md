# Tasks

- [x] Define single-feature scope, contracts, and implementation plan (`spec.md`, `plan.md`).
- [x] Add regex-free Cargo crate and `rustc` banner parsers (`src/domain/rust/rustSourceFingerprints.ts`) and extend `rustBinarySchema`, `rustBinaryQuery.ts`, and `rustBinaryView.ts`.
- [x] Expose ELF section flags on `ImageSection` and implement bounded linear recovery in `src/rust/RustInferredCrates.ts`.
- [x] Wire `RustBinaryImage`, `RustBinaryProvider` universal Mach-O slice rebasing and limitations, CLI flags (`--include-inferred-crates`, `--max-inferred-crates`), and MCP tool contracts.
- [x] Add unit, service, view, CLI decimal/integer, MCP, and multi-format acceptance tests (ELF, PE, thin Mach-O, universal Mach-O).
- [x] Update `docs/rust-binaries.md`, skill references, and `docs/specs/README.md`; pass all verification gates.
