# Implementation plan

## Boundary and contract

Add regex-free ASCII path and banner parsers in
`src/domain/rust/rustSourceFingerprints.ts`, and extend `rustBinarySchema` and
`inspectRustBinaryInputSchema` in `src/domain/rust/rustBinary.ts` with
`.exactOptional()` `include_inferred_crates`, `max_inferred_crates`,
`inferred_crates`, and `rustc_versions` fields plus structural, ordering,
artifact-bounds, and universal Mach-O slice refinements. Extend
`src/domain/rust/rustBinaryQuery.ts` and
`src/domain/analysisView/rustBinaryView.ts` with `source_coverage.inferred_crates`,
summary counts, and the `inferred_crates` paged collection.

Expose ELF section `flags` on `ImageSection` in
`src/native/metadata/BinaryContainer.ts` and `src/native/metadata/ElfImage.ts`
so `src/rust/RustInferredCrates.ts` can include uncompressed, file-backed,
non-writable/non-executable ELF `.comment` (`SHT_PROGBITS`) sections alongside
merged read-only sections and ELF read-only `PT_LOAD` ranges without widening
`rustc_commit` range rules. Scan `1 MiB` windows with `Buffer.indexOf`, boundary
overlap, `64 MiB` scan budgeting, bounded deduplication maps, and periodic
`assertArtifactReadActive` checks, then rebase slice-relative offsets in
`src/rust/RustBinaryProvider.ts`.

## Incremental work and validation

1. Add `rustSourceFingerprints.ts` and extend `rustBinary.ts`,
   `rustBinaryQuery.ts`, and `rustBinaryView.ts` while keeping default behavior
   unchanged.
2. Implement `recoverRustSourceFingerprints` in `src/rust/RustInferredCrates.ts`
   and wire `RustBinaryImage.ts`, `RustBinaryProvider.ts`, `rustCommands.ts`
   (`cliDecimalField`), and `rustToolContracts.ts`.
3. Add unit, service, view, boundary, CLI decimal/integer, MCP, and acceptance
   tests across ELF, PE, thin Mach-O, and universal Mach-O slice fixtures.
4. Update the [Rust binary guide](../../../rust-binaries.md), skill guidance,
   and feature specification index; pass formatting, build, test, catalog, and
   documentation checks.

## Effects and compatibility

Default `inspect_rust_binary` calls omit `inferred_crates` and `rustc_versions`,
preserving byte-for-byte identical outputs and `evidence_id` digests as well as
historical `Evidence` bundle validation. No external tool, network call, or
target execution is introduced.
