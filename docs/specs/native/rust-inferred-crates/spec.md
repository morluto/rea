# Rust inferred crate and rustc version fingerprints

## Problem and outcome

Most compiled Rust executables and shared libraries omit `cargo-auditable`
(`.dep-v0` / `__DATA,.dep-v0`), returning `auditable_metadata: null`, and builds
that remap `/rustc/<40-hex>/` paths return `rustc_commit: null` even when
read-only panic/debug source paths or ELF `.comment` sections preserve Cargo
registry/git crate paths and `rustc` version banners. Extend
`inspect_rust_binary` / `inspect-rust-binary` with opt-in, bounded recovery of
path-inferred Cargo crates and `rustc` toolchain banners across ELF, PE, thin
Mach-O, and universal Mach-O slices.

## Requirements

- Keep `include_inferred_crates` opt-in (`.exactOptional()`, omitted by default)
  so default `inspect_rust_binary({ path })` calls stay byte-for-byte identical
  in parameters, normalized output, limitations, and `evidence_id`, and existing
  stored `Evidence` bundles validate without migration.
- Accept `max_inferred_crates` (`1..10,000`, default `1,000`) only when
  `include_inferred_crates` is `true` (CLI `--include-inferred-crates` and
  decimal-admitted `--max-inferred-crates`).
- Scan merged read-only file ranges (including ELF read-only non-executable
  `PT_LOAD` ranges) plus uncompressed, file-backed, non-writable/non-executable
  ELF `.comment` (`SHT_PROGBITS`) sections with linear ASCII/byte parsers, zero
  backtracking regular expressions, and periodic `AbortSignal` cancellation
  checks.
- Recover deduplicated `inferred_crates` (`evidence_kind: "inferred"`):
  - Registry source paths (`cargo/registry/src/<index>/<crate>-<semver>/` across
    `/cargo/...`, `/.cargo/...`, and Windows `\` separators), splitting
    `<crate>-<semver>` at the first `-` followed by a valid Cargo SemVer
    `MAJOR.MINOR.PATCH` so hyphenated crate names and pre-release/build-metadata
    versions stay unambiguous.
  - Git checkout source paths
    (`cargo/git/checkouts/<repo_slug>-<16-hex-id>/<7..40-hex-rev>/` across `/`
    and `\` separators).
- Recover deduplicated `rustc_versions` (`evidence_kind: "inferred"`, capped at
  `64` banners) for `rustc [version ]<MAJOR.MINOR.PATCH>[-channel][ (<hex> <YYYY-MM-DD>)]`
  strings in read-only and ELF `.comment` sections.
- Rebase `first_file_offset` values by universal Mach-O slice offsets and enforce
  slice range containment in `rustBinarySchema`.
- Enforce the `64 MiB` scan cap and item caps by setting `truncated: true` and
  recording explicit truncation and epistemic limitations rather than failing.
- Expose `source_coverage.inferred_crates` (`"not-requested" | "complete" | "truncated"`),
  summary counts, and `inspect_analysis_view` (`kind: "rust"`,
  `collection: "inferred_crates"`) paging and filtering (`indices`, `name`,
  `names`, `contains`, `source_kind`, `fields`, `offset`, `limit`), refusing
  cleanly when the parent Evidence did not collect `inferred_crates`.

## Acceptance

Unit, boundary, MCP, and CLI acceptance tests cover hyphenated and numeric crate
names (`tokio-util-0.7.13`, `futures-channel-0.3.31`, `x86_64-0.15.2`,
`rand_chacha-0.3.1`, `serde-1.0.217-alpha.1`, build metadata), Windows `\`
separators, git checkouts, `.rodata` and ELF `.comment` `rustc` banners,
ELF/PE/thin-Mach-O/universal-Mach-O offset rebasing, cancellation, item and scan
truncation, CLI decimal option admission, and retained view projections.

## Out of scope

Reconstructing transitive dependency edges without `.dep-v0`, DWARF DIE tree
decoding, symbol demangling heuristics, or binary execution.
