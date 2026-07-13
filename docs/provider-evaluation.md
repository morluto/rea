# Static-analysis provider evaluation

Status: research for issue #26; no provider implementation is approved by this note.

REA should add another analysis provider only after the provider-neutral capability
contracts, Evidence v2 metadata, ownership rules, and multi-fixture conformance
suite are complete. A provider is not a drop-in replacement for Hopper: every
capability must be mapped explicitly, with truthful `unavailable` results where
the engine cannot provide equivalent semantics.

## Shortlist

| Provider                                                                                    | License / automation surface                                                                                                                                           | What it brings                                                                                                                                          | REA fit and blockers                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra)                                  | Apache-2.0 source license; `analyzeHeadless`, Java APIs, and PyGhidra                                                                                                  | Broad static analysis, many processors and formats, scripting, and project/database workflows                                                           | Strong candidate for a full provider. Requires a Java/JDK runtime, isolated project/cache directories, process supervision, and a stable adapter for Ghidra's project-oriented model.                                                                                  |
| [Rizin](https://github.com/rizinorg/rizin) / [rz-pipe](https://github.com/rizinorg/rz-pipe) | Rizin repository contains LGPL-3.0 and GPL-3.0 components; `rizin`, `rz-bin`, and language bridges through `rzpipe`                                                    | Portable CLI analysis, disassembly/debugging, many architectures and file formats, JSON command output                                                  | Good candidate for a process-backed Linux provider and fast metadata fallback. License/component inventory must be preserved; command output needs version-pinned parsers and semantic conformance before evidence is trusted.                                         |
| [LIEF](https://github.com/lief-project/LIEF)                                                | Apache-2.0; C++, Python, and other bindings                                                                                                                            | Deterministic parsing and modification of ELF, PE, Mach-O, COFF, and related executable formats; headers, sections, symbols, relocations, and functions | Best near-term complement, not a decompiler replacement. It can cover format metadata and artifact evidence without a long-lived analysis process; function semantics, pseudocode, CFG, and cross-reference parity remain out of scope unless separately demonstrated. |
| [Binary Ninja](https://docs.binary.ninja/dev/index.html)                                    | API/documentation components are MIT, while the analysis product is licensed by edition; commercial, Ultimate, or Headless license is required for headless automation | Python/Core/C++/Rust APIs, headless loading, IL layers, function analysis, plugins, and configurable analysis                                           | Strong technical fit for a native provider, especially function dossiers. Commercial licensing, license-secret handling, native runtime packaging, and multithreaded lifecycle rules are material deployment blockers.                                                 |

## Recommended order

1. Use LIEF first for provider-neutral binary metadata where the current
   contracts already describe headers, sections, symbols, and relocations.
2. Evaluate Rizin as a separate process provider for portable disassembly and
   command-backed queries, with JSON-only parsing and fixture assertions.
3. Evaluate Ghidra or Binary Ninja for decompilation and richer function
   semantics only after the conformance fixtures can compare evidence by
   capability rather than by provider-specific output text.

## Required admission gate

Before implementation, an adapter proposal must provide:

- a capability matrix covering supported, unsupported, and degraded results;
- provider identity, version, target digest, authority, limitations, and
  deterministic locations in every Evidence v2 record;
- bounded subprocess or library lifetime, cancellation, timeouts, and cleanup;
- sanitized diagnostics that do not expose license material, host paths, or
  provider tracebacks;
- the same source-owned fixture corpus across architectures and formats;
- repeatable checks for function identity, addresses, strings, names, xrefs,
  CFG, and pseudocode wherever those capabilities are claimed.

This keeps issue #26 a decision record rather than prematurely committing REA
to an engine whose semantics or redistribution terms have not been verified.

## Primary-source notes

- Ghidra documents headless batch mode and its Java/Python runtime requirements
  in its [Getting Started guide](https://github.com/NationalSecurityAgency/ghidra/blob/master/GhidraDocs/GettingStarted.md).
- Rizin lists supported formats, architectures, tools, and `rzpipe` bridges in
  its [repository README](https://github.com/rizinorg/rizin); `rz-pipe` documents
  JSON command transport and pipe backends.
- LIEF's [format tutorial](https://lief.re/doc/stable/tutorials/01_play_with_formats.html)
  and [Python API](https://lief.re/doc/latest/api/binary_abstraction/python.html)
  document parsing and format-agnostic binary access.
- Binary Ninja documents its [headless automation model](https://docs.binary.ninja/dev/batch.html),
  [edition licenses](https://docs.binary.ninja/about/license.html), and the
  [MIT license for API/documentation components](https://docs.binary.ninja/about/open-source.html).
