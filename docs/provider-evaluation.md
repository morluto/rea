# Static-analysis provider evaluation

This guide describes repository main. Check the [released package boundary](installation.md#released-package-and-main) when using npm.

Ghidra read-only analysis is available on Linux x64 and macOS x64/arm64.
Install Ghidra 12.1.4 and a full 64-bit JDK 21 separately, then configure REA to
use them. macOS installations need the matching native decompiler.

REA imports one target into a temporary project and exposes 25 read-only
operations after analysis completes. They cover inventories, search,
decompilation, assembly, function metadata, resolved calls, references, control
flow, instructions, and recovered types. Results identify the provider version,
analysis settings, target digest, and any unavailable or incomplete facts.
On Linux and macOS, `annotate_native_function` additionally edits names and entry
comments atomically, verifies readback, and returns refreshed function analysis.
Changes live only in the session database and leave executable bytes unchanged.
Ghidra does not expose GUI controls; Windows P0 remains read-only.

Windows x64 P0 supports native x86-64 PE applications on local NTFS with
bundled Job Object ownership, protected runtime DACLs, and handle-based path
admission. Real ordinary-user verification covers all 25 read-only operations
through the packaged CLI and MCP, target integrity, and cleanup. This remains
an experimental boundary; see [Windows Ghidra P0](windows-ghidra-p0.md) and
[issue #527](https://github.com/morluto/rea/issues/527).

[ADR-0001](adr/0001-provider-selection-and-analysis-profiles.md) fixes the
provider registry, deterministic selection, target binding, analysis profile,
snapshot migration, and compatibility semantics that implementation must
follow.

## Approved Ghidra v1 boundary

- Keep the existing provider-neutral CLI and MCP tool names.
- Bind one deep-analysis provider to a target for the target's lifetime; never
  fail over silently between Hopper and Ghidra.
- Use an existing Ghidra installation and a compatible Java runtime. Setup must
  not install or upgrade Ghidra or Java.
- Run Ghidra headlessly in an owned process with a private temporary project,
  startup and cleanup deadlines, caller cancellation, and complete replies.
- Prefer a packaged Java bridge loaded through Ghidra's script path. PyGhidra
  remains useful for prototypes but is not a mandatory production dependency.
- Treat authenticated `ping` and `shutdown` as lifecycle proof only. Inventory,
  xref, CFG, and decompilation claims require separately admitted operation
  contracts and real-provider conformance.
- Implement read-only inventories, assembly, decompilation, function metadata,
  calls, references, containment, and complete inventory search first.
- Report GUI cursor/navigation and persistent mutation operations as unavailable
  until their semantics and project ownership are explicitly designed.
- Verify real claims on Linux with at least two distinct source-owned binaries.
  Verify the Windows host claim with the deterministic source-owned x86-64 PE
  fixture and all admitted operations; compare normalized semantic facts rather
  than provider-specific pseudocode text.

## Shipped foundation boundary

`GHIDRA_INSTALL_DIR` must identify an extracted official 12.1.4 release;
optional `JAVA_HOME` must identify a 64-bit full JDK 21, otherwise doctor probes
`java`/`javac` or `java.exe`/`javac.exe` from `PATH`. Supported Linux and macOS
hosts accept compatible ELF, PE, and Mach-O executable targets. Host admission
and target compatibility are separate checks. Windows x64 P0 admits only native,
non-managed, non-DLL x86-64 PE applications on fixed local NTFS, with the packaged
native authority available before launch.

The launcher creates one ephemeral runtime root with project,
home/cache/config/data/temp, logs, descriptor, endpoint, target snapshot, and
ownership manifest.
It passes `-readOnly` and `-deleteProject`, and uses Ghidra's default analysis
and resource settings; inherited Java option injection variables are cleared.
On Linux, the mode-0600 descriptor carries the random token without
exposing it in argv or environment and the Java bridge binds a mode-restricted
Unix socket. macOS uses the same local transport. The bridge reports actual
Ghidra/language/compiler/analysis/import-digest metadata and accepts only
authenticated `ping`, `shutdown`, thirteen read-only inventory/load-image methods,
and twelve function-analysis methods. Linux/macOS also admits atomic function
annotation changes in the ephemeral database. Close, cancellation, timeout, malformed protocol,
or process exit stops the owned process resources, closes the socket, and
removes the runtime root.

The experimental Windows transport uses authenticated IPv4 loopback with a
token-free endpoint record. The bundled native authority establishes Job Object
ownership, protected runtime DACLs, and handle-based path admission before
launch. If the bundle or an admission constraint is unavailable, the provider
remains unavailable; a `taskkill` fallback does not establish that authority.

The provider catalog lists 25 read-only Ghidra operations and the Linux/macOS
session annotation operation. GUI cursor/navigation and persistent mutations
remain unavailable; Windows P0 admits no database mutation. The router therefore
reports them unavailable instead of borrowing Hopper semantics or inferring
capability from a successful import.

## Admitted inventory semantics

| Concern          | Ghidra contract                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program identity | One `analyzeHeadless` import produces exactly one Program; `list_documents` therefore returns exactly one name.                                                                                                                                                                                 |
| Addresses        | Default memory uses lowercase `0x` hexadecimal. Non-default and external spaces use `<percent-encoded-space>:0x<hex>` and remain round-trippable. The handshake commits image base and default address-space name.                                                                              |
| Symbols          | `list_names` includes address-bearing memory and external symbols, including dynamic symbols, while excluding variable and no-address namespace records. Each item reports primary, dynamic, external, symbol type, and source facts.                                                           |
| Procedures       | Both non-external and external functions are listed. A local thunk remains distinct from its resolved target; exact and qualified name lookup fails on ambiguity rather than guessing.                                                                                                          |
| Strings          | Only Ghidra-defined string `Data` is observed. Items report charset, byte length, and whether a required null terminator is missing. The API cannot distinguish a present terminator from fixed/Pascal layouts when no terminator is missing, so that state is named `present_or_not_required`. |
| Memory           | Memory-block end addresses are exclusive. Read/write/execute, initialization, overlay, address space, and image base are direct Ghidra observations.                                                                                                                                            |
| Inventory        | Procedure, symbol, and string listings plus searches return the complete matching collection in one response; callers do not provide offsets or result-count limits.                                                                                                                            |
| Search           | Literal and Java-regex searches scan the complete immutable inventory and return all matching entries inline. Search waits for a reply or caller cancellation; there are no caller-supplied offsets or result-count limits.                                                                     |
| Analysis state   | The socket is exposed only after default auto-analysis completes. Established operations wait for their reply or caller cancellation; there is no fixed response-size ceiling.                                                                                                                  |

## Admitted function-analysis semantics

| Concern                 | Ghidra contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decompiler lifetime     | One persistent `DecompInterface` is opened for the imported Program and disposed during bridge shutdown. Native decompilation has no fixed per-function deadline. External functions or functions without bodies return `null`; cancellation and native failure remain distinct.                                                                                                                                                                                                                                                                                                                                           |
| Serialization           | A FIFO sends one Program request at a time. Caller cancellation removes queued work promptly and is passed to active socket waits. This is an adapter safety commitment, not a claim that every Ghidra API is thread-safe.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Function identity       | Every function result carries the entry address and Ghidra FunctionManager classification for external, thunk, and resolved thunk target. These are observations, not proof that unresolved targetless calls have been recovered.                                                                                                                                                                                                                                                                                                                                                                                          |
| Assembly and pseudocode | Assembly is complete Ghidra Listing text; pseudocode is Ghidra decompiler output. Neither is original source, and cross-provider comparison never treats Hopper and Ghidra text as equal or unequal semantic facts.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Instruction fast path   | `read_function_instructions` returns every raw Listing instruction for the requested function without invoking the decompiler or whole-program name/string inventories.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Calls and references    | Callers/callees contain only resolved functions. Reference edges preserve exact ReferenceManager type and call/jump/data/read/write/indirect/computed/conditional/terminal/external facts. Targetless computed flow remains unknown. Synthetic entry-point references without actionable memory sources are omitted explicitly.                                                                                                                                                                                                                                                                                            |
| CFG                     | Dossiers use `BasicBlockModel` and retain only non-call successors inside the function body. CFG topology is address-normalized for comparison; provider-specific block construction remains a declared difference.                                                                                                                                                                                                                                                                                                                                                                                                        |
| P-code value flow       | Function dossiers include up to 3,000 high-p-code operations, at most 64 inputs per operation, and 12,000 def-use edges. Results identify memory reads/writes, branches, and calls by p-code opcode, and mark decompiler-dead operations. Large results report truncation, an omitted-operation lower bound, and known omitted-input/edge counts. The dossier is an intra-function graph; `trace_native_values` composes derived parameter/argument and return/output dependencies across resolved calls. It does not resolve memory aliasing, call side effects, runtime behavior, persistent state, or business meaning. |
| Result extent           | Function instruction scans and native API boundary observations remain complete. P-code flow is the explicit bounded exception; its count fields distinguish exact retained counts from lower-bound or known-omitted counts. Caller cancellation and provider failures remain distinct.                                                                                                                                                                                                                                                                                                                                    |

`npm run verify:ghidra` compiles the versioned C oracle into debug and stripped
host-native targets (x86-64 ELF on Linux x64 or Mach-O on macOS), plus a native
DWARF 4 type-layout object. It proves the admitted operations, external functions, resolved thunks, exports, stripped-name
behavior, direct and targetless indirect calls, typed references, strings/xrefs,
multi-block CFG, bounded p-code def-use/effect links, semantic enhanced workflows, cancellation, startup deadlines,
serialized concurrency, malformed-target rejection, profile identity, and
process/project cleanup against real Ghidra 12.1.4. Unit fixtures separately
cover startup deadlines, process exit, queued cancellation, and malformed wire
output.

`npm run verify:ghidra:cross-format` adds AArch64 ELF, x86-64 PE, and x86-64
Mach-O target coverage. It requires `clang`, LLD, and `lld-link`; set
`REA_CLANG`, `REA_LLD`, or `REA_LLD_LINK` to select them. The verifier checks
these tools before compilation. Keeping this matrix separate lets Linux
host/provider acceptance run with only the host compiler.

`npm run verify:ghidra:windows` checks the source-owned native x86-64 PE
fixture, all 25 read-only operations, target/snapshot/import SHA-256 linkage,
and project, endpoint, process, and runtime cleanup. The independent native
lane checks DACLs, handle admission, cancellation, and Job Object lifecycle.
`npm run verify:ghidra:windows:package` packs and installs REA into an isolated
prefix, then checks ordinary-user CLI/MCP operations against canonical contracts.
All lanes require matching native controls; package startup alone establishes
only package compatibility.

## Shared provider-process foundation

`src/process/` now provides the mechanisms that a long-lived Hopper or Ghidra
adapter shares: POSIX run-token-authenticated process-group ownership,
ephemeral temporary runtime roots, one absolute startup deadline, correlated
request cancellation and lifecycle-deadline cleanup, bounded stdout and stderr retention with
exact byte counts, process-exit diagnostics, and bounded TERM-to-KILL shutdown.
Reusable fixtures exercise exit, timeout, cancellation, graceful termination,
forced termination, double-close, spawn failure, and resource release. Windows
Ghidra uses its native Job Object, private runtime, and path-admission boundary;
generic process-tree termination alone cannot establish provider availability.

The foundation does not define a bridge schema, socket framing, health payload,
analysis model, or shutdown acknowledgement. Hopper keeps its authenticated
NDJSON-over-Unix-socket protocol in `src/hopper/`; Ghidra has a separate strict
NDJSON protocol implemented by the packaged Java `HeadlessScript` and reuses
only the generic process mechanisms.

## Shortlist

| Provider                                                                                    | License / automation surface                                                                                                                                           | What it brings                                                                                                                                          | REA fit and blockers                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra)                                  | Apache-2.0 source license; `analyzeHeadless`, Java APIs, and PyGhidra                                                                                                  | Static analysis, multiple processors and formats, scripting, and project/database workflows                                                             | 25 read-only operations shipped on Linux/macOS with installation checks, temporary projects, a serial API queue, and real ELF/PE/Mach-O conformance. Experimental Windows x64 P0 supports native x86-64 PE on local NTFS with bundled native controls and ordinary-user CLI/MCP verification; Linux/macOS additionally support atomic session function annotations; Windows mutation and all Ghidra GUI operations are unavailable. |
| [Rizin](https://github.com/rizinorg/rizin) / [rz-pipe](https://github.com/rizinorg/rz-pipe) | Rizin repository contains LGPL-3.0 and GPL-3.0 components; `rizin`, `rz-bin`, and language bridges through `rzpipe`                                                    | Portable CLI analysis, disassembly/debugging, many architectures and file formats, JSON command output                                                  | Good candidate for a process-backed Linux provider and fast metadata fallback. License/component inventory must be preserved; command output needs version-pinned parsers and semantic conformance before evidence is trusted.                                                                                                                                                                                                      |
| [LIEF](https://github.com/lief-project/LIEF)                                                | Apache-2.0; C++, Python, and other bindings                                                                                                                            | Deterministic parsing and modification of ELF, PE, Mach-O, COFF, and related executable formats; headers, sections, symbols, relocations, and functions | Best near-term complement, not a decompiler replacement. It can cover format metadata and artifact evidence without a long-lived analysis process; function semantics, pseudocode, CFG, and cross-reference parity remain out of scope unless separately demonstrated.                                                                                                                                                              |
| [Binary Ninja](https://docs.binary.ninja/dev/index.html)                                    | API/documentation components are MIT, while the analysis product is licensed by edition; commercial, Ultimate, or Headless license is required for headless automation | Python/Core/C++/Rust APIs, headless loading, IL layers, function analysis, plugins, and configurable analysis                                           | Strong technical fit for a native provider, especially function dossiers. Commercial licensing, license-secret handling, native runtime packaging, and multithreaded lifecycle rules are material deployment blockers.                                                                                                                                                                                                              |

## Recommended order

1. Use the implemented explicit provider registry and target binding without
   changing Hopper behavior.
2. Maintain the admitted Ghidra function boundary through the shared
   conformance corpus and add formats or semantics only after real proof.
3. Connect Electron/native-add-on application findings to the selected native
   analysis provider without introducing provider-prefixed tools.
4. Evaluate LIEF or Rizin later as complementary metadata/disassembly providers,
   and Binary Ninja as an optional licensed provider, using the same admission
   gate.

## Required admission gate

Before implementation, an adapter proposal must provide:

- a capability matrix covering supported, unsupported, and degraded results;
- provider identity, version, analysis profile, target digest, authority,
  limitations, and deterministic locations in every Evidence record;
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

- Ghidra 12.1.4 documents headless batch mode and its Java runtime requirements
  in its [release-specific Getting Started guide](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/GhidraDocs/GettingStarted.md);
  the [official release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build)
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
