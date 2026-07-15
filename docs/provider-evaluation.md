# Static-analysis provider evaluation

Status: Ghidra is approved as the direction for REA's next full read-only
analysis provider. This note does not claim that Ghidra support is implemented
or shipped.

Implementation remains gated on explicit target-to-provider binding, a generic
analysis-profile commitment for evidence and snapshots, bounded provider
ownership, and a multi-fixture conformance suite. A provider is not a drop-in
replacement for Hopper: every capability must be mapped explicitly, with
truthful `unavailable` or degraded results where the engine cannot provide
equivalent semantics.

[ADR-0001](adr/0001-provider-selection-and-analysis-profiles.md) fixes the
provider registry, deterministic selection, target binding, analysis profile,
snapshot migration, and compatibility semantics that implementation must
follow.

## Approved Ghidra v1 boundary

- Keep the existing provider-neutral CLI and MCP tool names.
- Bind one deep-analysis provider to a target for the target's lifetime; never
  fail over silently between Hopper and Ghidra.
- Start with bring-your-own Ghidra and a compatible Java runtime. Setup must not
  install or upgrade Java.
- Run Ghidra headlessly in an owned process with a private temporary project,
  bounded startup/analysis/request deadlines, cancellation, and cleanup.
- Prefer a packaged Java bridge loaded through Ghidra's script path. PyGhidra
  remains useful for prototypes but is not a mandatory production dependency.
- Implement read-only inventories, assembly, decompilation, function metadata,
  calls, references, containment, and bounded search first.
- Report GUI cursor/navigation and persistent mutation operations as unavailable
  until their semantics and project ownership are explicitly designed.
- Verify real claims on Linux with at least two distinct source-owned binaries;
  compare normalized semantic facts rather than provider-specific pseudocode
  text.

## Shortlist

| Provider                                                                                    | License / automation surface                                                                                                                                           | What it brings                                                                                                                                          | REA fit and blockers                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra)                                  | Apache-2.0 source license; `analyzeHeadless`, Java APIs, and PyGhidra                                                                                                  | Broad static analysis, many processors and formats, scripting, and project/database workflows                                                           | Strong candidate for a full provider. Requires a Java/JDK runtime, isolated project/cache directories, process supervision, and a stable adapter for Ghidra's project-oriented model.                                                                                  |
| [Rizin](https://github.com/rizinorg/rizin) / [rz-pipe](https://github.com/rizinorg/rz-pipe) | Rizin repository contains LGPL-3.0 and GPL-3.0 components; `rizin`, `rz-bin`, and language bridges through `rzpipe`                                                    | Portable CLI analysis, disassembly/debugging, many architectures and file formats, JSON command output                                                  | Good candidate for a process-backed Linux provider and fast metadata fallback. License/component inventory must be preserved; command output needs version-pinned parsers and semantic conformance before evidence is trusted.                                         |
| [LIEF](https://github.com/lief-project/LIEF)                                                | Apache-2.0; C++, Python, and other bindings                                                                                                                            | Deterministic parsing and modification of ELF, PE, Mach-O, COFF, and related executable formats; headers, sections, symbols, relocations, and functions | Best near-term complement, not a decompiler replacement. It can cover format metadata and artifact evidence without a long-lived analysis process; function semantics, pseudocode, CFG, and cross-reference parity remain out of scope unless separately demonstrated. |
| [Binary Ninja](https://docs.binary.ninja/dev/index.html)                                    | API/documentation components are MIT, while the analysis product is licensed by edition; commercial, Ultimate, or Headless license is required for headless automation | Python/Core/C++/Rust APIs, headless loading, IL layers, function analysis, plugins, and configurable analysis                                           | Strong technical fit for a native provider, especially function dossiers. Commercial licensing, license-secret handling, native runtime packaging, and multithreaded lifecycle rules are material deployment blockers.                                                 |

## Recommended order

1. Add explicit provider selection, target binding, and analysis-profile-aware
   snapshot identity without changing existing Hopper behavior.
2. Implement the bounded read-only Ghidra provider described above and admit
   capabilities individually through the shared conformance corpus.
3. Connect Electron/native-add-on application findings to the selected native
   analysis provider without introducing provider-prefixed tools.
4. Evaluate LIEF or Rizin later as complementary metadata/disassembly providers,
   and Binary Ninja as an optional licensed provider, using the same admission
   gate.

## Required admission gate

Before implementation, an adapter proposal must provide:

- a capability matrix covering supported, unsupported, and degraded results;
- provider identity, version, analysis profile, target digest, authority,
  limitations, and deterministic locations in every Evidence v2 record;
- bounded subprocess or library lifetime, cancellation, timeouts, and cleanup;
- actionable local diagnostics that retain paths, digests, mismatch locations,
  and provider metadata while redacting credentials, authorization headers,
  license secrets, and other genuine secrets;
- the same source-owned fixture corpus across architectures and formats;
- repeatable checks for function identity, addresses, strings, names, xrefs,
  CFG, and pseudocode wherever those capabilities are claimed.

These gates turn the accepted direction into verified capabilities rather than
prematurely claiming equivalence or redistribution support.

## Primary-source notes

- Ghidra 12.1.2 documents headless batch mode and its Java runtime requirements
  in its [release-specific Getting Started guide](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.2_build/GhidraDocs/GettingStarted.md);
  the [official release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.2_build)
  supplies the corresponding distribution and checksums.
- Rizin lists supported formats, architectures, tools, and `rzpipe` bridges in
  its [repository README](https://github.com/rizinorg/rizin); `rz-pipe` documents
  JSON command transport and pipe backends.
- LIEF's [format tutorial](https://lief.re/doc/stable/tutorials/01_play_with_formats.html)
  and [Python API](https://lief.re/doc/latest/api/binary_abstraction/python.html)
  document parsing and format-agnostic binary access.
- Binary Ninja documents its [headless automation model](https://docs.binary.ninja/dev/batch.html),
  [edition licenses](https://docs.binary.ninja/about/license.html), and the
  [MIT license for API/documentation components](https://docs.binary.ninja/about/open-source.html).
