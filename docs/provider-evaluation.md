# Static-analysis provider evaluation

Status: the Ghidra read-only analysis provider is shipped. It validates an
exact bring-your-own Ghidra 12.1.2/JDK 21 environment on Linux x64, resolves a
provider/version/profile commitment, runs one isolated read-only headless
import, and publishes 18 operation-level capabilities after the authenticated
post-analysis handshake.

The provider-neutral target, provider registry, deterministic target binding,
analysis-profile commitment, Evidence provenance, snapshot v2, and bounded
provider-process lifecycle foundations are implemented. The Ghidra launcher,
packaged Java bridge, doctor/setup projection, bounded client lifecycle, and
multi-target real Linux verifier are also implemented. Program identity,
procedure/string/symbol inventory, memory blocks, address/name and
containing-procedure resolution, bounded search, function metadata,
decompilation, assembly, resolved calls, typed references, xrefs, CFG, and
function dossiers are admitted. A provider is not a drop-in replacement for
Hopper: every capability is mapped explicitly, with truthful `unavailable`,
unknown, or degraded results where the engine cannot provide equivalent
semantics.

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
- Treat authenticated `ping` and `shutdown` as lifecycle proof only. Inventory,
  xref, CFG, and decompilation claims require separately admitted operation
  contracts and real-provider conformance.
- Implement read-only inventories, assembly, decompilation, function metadata,
  calls, references, containment, and bounded search first.
- Report GUI cursor/navigation and persistent mutation operations as unavailable
  until their semantics and project ownership are explicitly designed.
- Verify real claims on Linux with at least two distinct source-owned binaries;
  compare normalized semantic facts rather than provider-specific pseudocode
  text.

## Shipped foundation boundary

`GHIDRA_INSTALL_DIR` must identify an extracted official 12.1.2 release;
optional `JAVA_HOME` must identify a 64-bit full JDK 21, otherwise doctor probes
`java` and `javac` from `PATH`. The adapter currently rejects non-Linux hosts,
non-x64 hosts, other Ghidra/JDK versions, missing `analyzeHeadless`, non-
executable targets, unknown architectures, and formats other than ELF, PE, and
Mach-O before launch.

The launcher creates one mode-0700 runtime root with private project,
home/cache/config/data/temp, logs, descriptor, socket, and ownership manifest.
It passes `-readOnly`, `-deleteProject`, a 300-second per-file analysis limit,
two CPUs, and a 2 GiB heap; inherited Java option injection variables are
cleared. The mode-0600 descriptor carries the random token without exposing it
in argv or environment. The Java bridge deletes the descriptor after parsing,
binds a mode-0600 Unix socket, reports actual Ghidra/language/compiler/analysis
metadata, accepts only the exact authenticated `ping`, `shutdown`, and ten
inventory plus eight function-analysis methods, and deletes the socket. Close,
cancellation, timeout,
malformed protocol, or process exit stops the token-verified owned process
group and removes the entire runtime root.

The provider catalog lists only the 18 proved Ghidra operations. GUI cursor,
navigation, and mutation operations remain absent; the router therefore
reports them unavailable instead of borrowing Hopper semantics or inferring
capability from a successful import.

## Admitted inventory semantics

| Concern          | Ghidra contract                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Program identity | One `analyzeHeadless` import produces exactly one Program; `list_documents` therefore returns exactly one name.                                                                                                                                                                                                          |
| Addresses        | Default memory uses lowercase `0x` hexadecimal. Non-default and external spaces use `<percent-encoded-space>:0x<hex>` and remain round-trippable. The handshake commits image base and default address-space name.                                                                                                       |
| Symbols          | `list_names` includes address-bearing memory and external symbols, including dynamic symbols, while excluding variable and no-address namespace records. Each item reports primary, dynamic, external, symbol type, and source facts.                                                                                    |
| Procedures       | Both non-external and external functions are listed. A local thunk remains distinct from its resolved target; exact and qualified name lookup fails on ambiguity rather than guessing.                                                                                                                                   |
| Strings          | Only Ghidra-defined string `Data` is observed. Items report charset, byte length, and whether a required null terminator is missing. The API cannot distinguish a present terminator from fixed/Pascal layouts when no terminator is missing, so that state is named `present_or_not_required`.                          |
| Memory           | Memory-block end addresses are exclusive. Read/write/execute, initialization, overlay, address space, and image base are direct Ghidra observations.                                                                                                                                                                     |
| Pagination       | List limits are 500 and search limits are 100. Pages commit exact totals and advancing offsets; an inventory above one million items fails rather than returning a partial result labeled exhaustive.                                                                                                                    |
| Search           | Literal search scans the immutable inventory with a 1,000,000-unit cumulative work budget. Regex uses a conservative finite Java-regex subset with 10,000 static paths, 4,096 UTF-16 code units per candidate, and the same cumulative budget. Exceeding a budget fails explicitly; returned values identify truncation. |
| Analysis state   | The socket is exposed only after default auto-analysis. A 300-second analysis timeout fails target opening; ordinary established requests have a 10-second client deadline and every response has a 1 MiB ceiling.                                                                                                       |

## Admitted function-analysis semantics

| Concern                 | Ghidra contract                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decompiler lifetime     | One persistent `DecompInterface` is opened for the imported Program and disposed during bridge shutdown. Each native decompile has a 30-second deadline; the socket leaves a bounded 35-second projection window. External functions or functions without bodies return `null`; timeout, cancellation, and native failure remain distinct. |
| Serialization           | A bounded FIFO admits at most 32 active-plus-queued requests and sends one Program request at a time. Queue wait counts against the caller's deadline, and queued cancellation is prompt. This is an adapter safety commitment, not a claim that every Ghidra API is thread-safe.                                                          |
| Function identity       | Every function result carries the entry address and Ghidra FunctionManager classification for external, thunk, and resolved thunk target. These are observations, not proof that unresolved targetless calls have been recovered.                                                                                                          |
| Assembly and pseudocode | Assembly is bounded Ghidra Listing text; pseudocode is bounded Ghidra decompiler output. Neither is original source, and cross-provider comparison never treats Hopper and Ghidra text as equal or unequal semantic facts.                                                                                                                 |
| Calls and references    | Callers/callees contain only resolved functions. Reference edges preserve exact ReferenceManager type and call/jump/data/read/write/indirect/computed/conditional/terminal/external facts. Targetless computed flow remains unknown. Synthetic entry-point references without actionable memory sources are omitted explicitly.            |
| CFG                     | Dossiers use `BasicBlockModel` and retain only non-call successors inside the function body. CFG topology is address-normalized for comparison; provider-specific block construction remains a declared difference.                                                                                                                        |
| Bounds                  | Direct assembly fails above 100,000 instructions or the wire ceiling. Dossiers scan at most 5,000 requested instructions, return bounded independent pages, mark unknown totals after an incomplete scan, and paginate pseudocode by Unicode code points.                                                                                  |

`npm run verify:ghidra` compiles the versioned C oracles into x86-64 debug and
stripped ELF, AArch64 ELF, x86-64 PE, and x86-64 Mach-O targets. It proves all
18 operations, external functions, resolved thunks, exports, stripped-name
behavior, direct and targetless indirect calls, typed references, strings/xrefs,
multi-block CFG, semantic enhanced workflows, cancellation, deadlines,
serialized concurrency, malformed-target rejection, profile identity, and
process/project cleanup against real Ghidra 12.1.2. Unit fixtures separately
cover analysis/decompile timeouts, process exit, queue saturation, and malformed
wire output.

## Shared provider-process foundation

`src/process/` now provides the mechanisms that a long-lived Hopper or Ghidra
adapter genuinely shares: run-token-authenticated process-group ownership,
mode-0700 temporary runtime roots, one absolute startup deadline, correlated
request timeout/cancellation cleanup, bounded stdout and stderr retention with
exact byte counts, process-exit diagnostics, and bounded TERM-to-KILL shutdown.
Reusable fixtures exercise exit, timeout, cancellation, graceful termination,
forced termination, double-close, spawn failure, and resource release.

The foundation does not define a bridge schema, socket framing, health payload,
analysis model, or shutdown acknowledgement. Hopper keeps its authenticated
NDJSON-over-Unix-socket protocol in `src/hopper/`; Ghidra has a separate strict
NDJSON protocol implemented by the packaged Java `HeadlessScript` and reuses
only the generic process mechanisms.

## Shortlist

| Provider                                                                                    | License / automation surface                                                                                                                                           | What it brings                                                                                                                                          | REA fit and blockers                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra)                                  | Apache-2.0 source license; `analyzeHeadless`, Java APIs, and PyGhidra                                                                                                  | Broad static analysis, many processors and formats, scripting, and project/database workflows                                                           | Read-only analysis shipped: exact BYO checks, isolated state, bounded process and queue, packaged bridge, 18 admitted inventory/function operations, and real ELF/PE/Mach-O x86-64 plus AArch64 conformance. GUI and mutation semantics remain intentionally unavailable. |
| [Rizin](https://github.com/rizinorg/rizin) / [rz-pipe](https://github.com/rizinorg/rz-pipe) | Rizin repository contains LGPL-3.0 and GPL-3.0 components; `rizin`, `rz-bin`, and language bridges through `rzpipe`                                                    | Portable CLI analysis, disassembly/debugging, many architectures and file formats, JSON command output                                                  | Good candidate for a process-backed Linux provider and fast metadata fallback. License/component inventory must be preserved; command output needs version-pinned parsers and semantic conformance before evidence is trusted.                                            |
| [LIEF](https://github.com/lief-project/LIEF)                                                | Apache-2.0; C++, Python, and other bindings                                                                                                                            | Deterministic parsing and modification of ELF, PE, Mach-O, COFF, and related executable formats; headers, sections, symbols, relocations, and functions | Best near-term complement, not a decompiler replacement. It can cover format metadata and artifact evidence without a long-lived analysis process; function semantics, pseudocode, CFG, and cross-reference parity remain out of scope unless separately demonstrated.    |
| [Binary Ninja](https://docs.binary.ninja/dev/index.html)                                    | API/documentation components are MIT, while the analysis product is licensed by edition; commercial, Ultimate, or Headless license is required for headless automation | Python/Core/C++/Rust APIs, headless loading, IL layers, function analysis, plugins, and configurable analysis                                           | Strong technical fit for a native provider, especially function dossiers. Commercial licensing, license-secret handling, native runtime packaging, and multithreaded lifecycle rules are material deployment blockers.                                                    |

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
