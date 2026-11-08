# Mach-O dSYM companion admission

Issue: https://github.com/morluto/rea/issues/1193

## Problem and outcome

REA imports an immutable private executable snapshot into its ephemeral Ghidra
project, so an adjacent `.dSYM` bundle beside the caller's original Mach-O
executable is never visible to Ghidra's `DSymSectionProvider`. Stripped or
linked Mach-O binaries consequently lose DWARF parameter names, structured data
types, and source-anchored type paths unless the analyst manually prepares an
external Ghidra project.

Admit an explicitly caller-selected `.dSYM` bundle (`dsym_path` on MCP
`open_binary`, `--dsym-path` on native CLI commands), prove before provider
startup that a bundle member's `LC_UUID` and CPU identity match the selected
Mach-O target image, stage only the verified DWARF member beside the private
Ghidra snapshot, and record companion provenance in target-admission evidence
and the committed Ghidra analysis profile.

## Requirements

- **Explicit caller selection**: accept optional absolute `dsym_path` /
  `--dsym-path`; never infer or auto-discover adjacent `.dSYM` bundles.
  Omitting `dsym_path` preserves existing executable-only behavior.
- **Bundle shape and target applicability**: the resolved path must name a
  `.dSYM` bundle directory (`*.dSYM`, including trailing `/` or `/.`) containing
  regular-file DWARF members under `Contents/Resources/DWARF`. Bundle,
  directory, and member opens follow caller symlinks while admitting members
  only through REA's non-blocking regular-file owner (skipping or rejecting
  non-regular entries such as FIFOs, sockets, and device nodes). Target-admission
  and pairing failures — missing or non-`.dSYM` bundles, missing or empty
  `Contents/Resources/DWARF`, headerless formats (`raw-binary`, `dos-com`), and
  non-Mach-O targets — fail closed as caller input (`invalid_request` /
  `invalid_input`) with constraint `debug_companion_rejected`. Pairing
  `dsym_path` with pre-imported `REA_GHIDRA_PROJECT_PATH` sessions
  (`-process -noanalysis`) fails closed as a provider configuration conflict
  (`configuration_invalid` with `details.settings` naming
  `REA_GHIDRA_PROJECT_PATH`).
- **Mandatory `LC_UUID` and CPU matching**: thin and universal containers
  validate Mach-O header/load-command framing and universal slice bounds,
  alignment, overlap, and header-versus-table CPU agreement. Placeholder
  all-zero UUIDs never match. Reject targets without a usable `LC_UUID`,
  universal targets or members with duplicate `(cpuType, cpuSubtypeBase)` slices
  (`ambiguous_target_slice` / `ambiguous_member_slice`), bundles with no
  matching `(uuid, cpuType, cpuSubtypeBase)` member (`uuid_mismatch`), and
  distinct matching members whose SHA-256 digests disagree
  (`conflicting_matching_members`).
- **Bounded admission and handle ownership**: examine at most 16 entries in
  `Contents/Resources/DWARF`, cap matched member size and cumulative
  matching-member digest reads at 1 GiB (deduplicating hard links sharing one
  `(dev, ino, size)` file identity), and bound incremental header/UUID traversal
  to a 64 KiB read window and 64 MiB total header I/O across target and
  candidates. Preserve refusal diagnostics ahead of final-close cancellation,
  retain failed handles when descriptor or directory close fails, and honor
  cancellation across member reads, staging copies, and cleanup retries.
- **Private staging and provenance**: stage only the matched DWARF member inside
  REA's private runtime root at
  `<snapshot>.dSYM/Contents/Resources/DWARF/<snapshot>` via exclusive `0600`
  file creation and post-copy size/SHA-256/file-state verification, leaving the
  caller's bundle untouched. Record
  `dsym { source_path, member_sha256, uuid, staged_member }` in target-admission
  evidence and `debug_companion { source_path, uuid, member_sha256 }` in
  `GhidraAnalysisProfile` so companion-selected and bare runs never share an
  analysis-profile digest or Program checkpoint.

## Acceptance

- Domain tests cover thin and universal `LC_UUID` decoding, shared FAT container
  validation delegation, placeholder zero UUIDs, CPU/subtype matching, and
  duplicate-slice ambiguity.
- Boundary and process-global lifecycle tests cover `.dSYM` directory naming,
  non-regular member handling, entry/size/I/O limits, mismatch and conflict
  diagnostics, `REA_GHIDRA_PROJECT_PATH` configuration refusal, staging digest
  verification, analysis-profile and checkpoint isolation, and
  close-failure/cancellation invariants across directory, member, and staging
  handles.
- Real macOS `clang -g` + `dsymutil` fixtures verify CLI and MCP admission of
  matching bundles, caller-input rejection of mismatched bundles, and Ghidra
  DWARF recovery of imported signatures and structured types where Ghidra is
  available.
- User-facing prerequisites, CLI/MCP usage, and limits are documented in
  [Mach-O debug companion analysis with Ghidra](../../../providers/dsym.md).

## Out of scope

Implicit `.dSYM` discovery, DWARF source-file content acquisition, per-slice
companion overrides independent of target architecture selection, staging into
pre-existing `REA_GHIDRA_PROJECT_PATH` projects, Hopper/IDA companion staging,
and non-Mach-O debug companion formats.
