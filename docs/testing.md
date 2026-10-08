# Testing REA

Prefer evidence in this order: full end-to-end workflows with real production
providers, integration tests across data/API boundaries, then golden regressions
from real captured inputs. Keep focused module tests for distinct failure or
semantic cases that these workflows cannot reliably reproduce. A test's path
or suite name does not establish its behavioral depth.

Avoid tests that mirror getters, enum mappings, fixture helpers, or prescribed
call sequences, or assert cache object identity without a caller-visible contract.
Prefer representative workflows over a Cartesian matrix when rows cross the
same boundary. Retain combinations that exercise a distinct interaction, such as
filtering within a full-output envelope. Keep distinct command handlers,
producer representations, failure reasons, and lifecycle states covered.
Consolidate their shared setup without hiding the inputs or expected evidence.

Tests are grouped into Vitest projects so ownership, allowed dependencies and
runtime cost are visible from their paths. Before pruning a distinct boundary
regression, identify the replacement scenario and its assertions; passing
success journeys do not replace malformed input, cancellation, permission or
cleanup coverage. Trivial helper checks do not need a replacement. If only
tests consume a production module, trace CLI/MCP and verifier imports,
including imports of compiled files, and remove abandoned scaffolding with its
tests when it has no runtime consumer.

When a test expects a `Result` to succeed, throw its error before asserting the
returned value. An `.ok` assertion immediately before the same throwing guard
adds no coverage and hides the typed failure. A removed parser matrix can leave
one golden malformed-input case and a real filesystem lifecycle that proves
configure, update, readback, and removal; an add-only journey does not cover the
whole lifecycle.

Protocol fixtures must model the commands they support and their producer reply
shapes. Reject unmodeled commands instead of returning a generic success; an
empty result is appropriate only for a supported command with no result fields.

Keep transport-only in-memory MCP sessions in the MCP boundary lane and direct
filesystem workflows in the filesystem boundary lane. Real process-tree capture
belongs in the serial process boundary lane, including captures invoked through
MCP. Report unavailable capture authority as a named skip rather than returning
from the test without assertions. Reserve acceptance paths for journeys
through the compiled public CLI or MCP runtime. Calling a compiled private
workflow or injecting a provider still establishes its narrower integration
claim, even if a directory name calls it acceptance.

Emit a verifier's final success report only after awaited cleanup. Observe final
process lineage after closing its owned resources.

The Vitest runner releases cached native process inspectors during awaited
worker teardown. Fork termination does not run Node's normal exit hooks; a
per-file teardown would instead retire shared inspectors before later files
can use them.

Measure slow files before removing capacity regressions. Optimize repeated
process startup, fixture construction, and production algorithms when they
dominate runtime. Keep at least one input beyond each formerly failing size or
depth; smaller fixtures do not establish that truncation or stack exhaustion
has been fixed. Record the toolchain, coverage mode, and cache conditions when
comparing durations.

## Behavioral depths

| Depth        | Location                | What it proves                                                                                        |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Module       | `src/**/*.test.ts`      | One domain, service, or adapter through its narrow public surface                                     |
| Composition  | `tests/composition/**`  | Provider-neutral session and registry wiring; filesystem access is limited to fixture materialization |
| Boundary     | `tests/boundary/**`     | Exactly one production filesystem, process, network, browser, CLI, or provider boundary               |
| MCP boundary | `tests/boundary/mcp/**` | MCP transport and tool-contract boundaries with isolated sessions and explicit cleanup                |
| Acceptance   | `tests/acceptance/**`   | A compiled CLI or MCP journey; injected providers still make it integration                           |
| Conformance  | `tests/conformance/**`  | Shared provider contracts, parameterized by declared capabilities and explicit opt-outs               |
| Evaluation   | `tests/evaluation/**`   | Deterministic evaluator parsing, scoring, and report generation                                       |

Colocated domain tests may import only their owning domain and inward
dependencies. They do not construct sessions or servers and do not start
subprocesses or network listeners. Colocated application tests exercise one
service through explicit ports and recording adapters, never a CLI or MCP
entrypoint. Composition tests may assemble provider-neutral sessions and
registries but do not cross production filesystem, process, socket, or browser boundaries.
Boundary tests cross one production boundary. Only acceptance tests assemble
the complete runtime or invoke the compiled product surface.

Binary session, registry, lazy-client and snapshot module cases live under
`src/application/binary/`. Their composition cases stay in
`tests/composition/analysis-sessions/`; snapshot persistence and actual SDK calls
stay in the filesystem and MCP boundary lanes. The shared injected session fixture
serves several capabilities and remains under `tests/fixtures/`.

Focused immutable builders and recording ports shared by one test family live
beside their production owner as `src/**/*.fixture.ts`. They are typechecked
with the suite and excluded from package builds; broader runtime and provider
fixtures remain under `tests/fixtures/**`.

`tests/process-global/**` is reserved for cases with a demonstrated dependency
on process-global state. Those tests use isolated forks so environment and
exit-status changes cannot leak between files. Serialize a case only when it
demonstrably shares an external resource that cannot be isolated. Reusable,
test-scoped fixtures live under `tests/support/**`; immutable source artifacts
remain under `tests/fixtures/**`.
The process-global Vitest configuration contract rejects new direct temporary-root
creation outside the workspace seam and its narrowly documented boundary/package
exceptions.

Real Hopper, Ghidra, IDA, browser, package, and managed-code claims belong to their
explicit `npm run verify:*` lanes. The reconstruction-readiness lane also
checks deterministic rerun, tamper, and stale-input handling; those checks do
not execute extracted JavaScript modules. When application runtime behavior is
needed, exercise the actual target through browser, Electron, or process
capture. Real model trials are manual; Vitest covers deterministic evaluator
logic.

`verify:managed` runs the portable PE byte-fixture conformance entrypoint under
`scripts/verify/managed/`, with its byte builder under
`scripts/fixtures/managed/`. It checks static classification, members,
reconstruction, native-boundary relationships and application graphs without
executing fixture PE files. Operator-local manifests and actual ILSpy oracles
remain optional, separately reported checks; the real Ghidra NativeAOT lane has
its own toolchain prerequisites. See [the managed guide](managed-code-analysis.md)
for those configurations. Generated completion-ledger checks use the same owning
entrypoint and include its verifier/fixture files in their cache inputs.

## End-to-end, integration and golden evidence

Full E2E tests invoke the production command dispatcher and real providers,
without fake launchers, runners or responses. `verify:keyed-archive` writes an
actual Foundation binary archive, runs the CLI and a separate stdio MCP
subprocess, checks parity and pagination, rejects an escaping path and checks
an XML graph golden. `verify:asset-catalog` compiles source-owned colors with
`actool`, invokes real `assetutil`, then checks CLI/MCP results, exact catalog
digest, every raw metadata field, pagination and malformed input rejection.
Neither artifact workflow requires Hopper or launches it. Both run in macOS CI.
`verify:macos-bundle` needs only macOS with Command Line Tools. It compiles a
source-owned app with `clang`: a versioned framework, XPC services, an app
extension, a login item, a privileged helper, launchd plists, and a helper tool,
signed ad hoc. It packs the app as a directory, a `ditto` ZIP, and an APFS DMG,
then checks that `inspect-artifact` plus `project-apple-application-graph`
report the same bundle anatomy for all three through the CLI, with stdio MCP
parity. It also checks that the DMG is detached afterwards. The same app
covers `trace-dylib-resolution`:

- each resolution status and finding, with CLI/MCP parity;
- for every traced image, dependencies, rpaths, and install names equal to
  `otool -l`;
- for the main executable and an XPC service, a predicted load order equal to
  the images dyld actually loads under `DYLD_PRINT_LIBRARIES`.

The lane also compiles executable/library pairs with empty embedded directory,
versioned-path, and suffix settings. It checks present and removed dependencies
through CLI and MCP, and compares actual `DYLD_PRINT_SEARCHING` diagnostics for
root-level candidates. These cases distinguish an empty search directory from
an empty versioned scan or a suffix that only repeats the original path.

It runs in macOS CI.

Apple artifact verifiers live in `scripts/verify/apple/`, with the macOS bundle
builder under `scripts/fixtures/apple/` and NIB byte fixtures beside the decoder
in `src/artifacts/apple/`. The npm entrypoints are unchanged. Format-specific
Swift/XIB/asset sources and goldens retain their locations; real Apple workflows
resolve them from the verifier file URL and run in the macOS CI lane.

Portable native semantics and their tests live in `src/domain/native/`; shared
analyst workflows and service-lane tests live in `src/application/native/`.
Named native contracts live in `src/contracts/native/`. Provider protocol and
host UI tests retain their adapter/boundary lanes, and real verifier command
names remain unchanged.
The existing Apple CI job also runs the host Swift-demangling CLI/MCP regression
suites, including option-like symbols, carriage returns and multiline rejection.

Process semantics/tests live in `src/domain/process/`; PTY capture implementation
and forked helper tests live in `src/process/capture/`. Evidence projection and
file workflows live in `src/application/process/`; producer-backed Evidence/host
cases run in the serial `tests/boundary/process/` lane. Installed-package probes
load the compiled capture capability owner, including the missing-optional-module
case. Real capture tests preserve actual descendant and cleanup checks.
The existing Apple job also exercises the relocated filesystem snapshot identity,
cancellation and descriptor cleanup regressions on macOS.

Prepare the native inspector before cases that measure producer output or exit
behavior; keep startup deadlines and cancellation in distinct cases. Run real
process-capture verification separately from package or build checks. On macOS,
new npm processes can become token-unreadable after changing their display
title and prevent verified cleanup during a capture's ownership sweep.

MCP SDK transport tests with recording providers remain integration tests.
They are useful for schema drift and failure projection but do not prove that
Hopper, Ghidra or another substituted engine works. `verify:package` proves
packaging/install behavior and fake-provider integration; use the corresponding
real-provider lanes for engine claims. Packed-bridge checks verify shipped files
and Python syntax without deleted mock fixtures or source-spelling assertions.
Real Apple dispatch and Interface
Builder verifiers currently prove format integration through production readers.

`verify:hopper` exercises an installed Hopper through the production stdio MCP
server and CLI. It checks source-owned call chains, CFG edges, references and
complete large inventories, then probes unnamed bookmarks, annotation clearing,
batch validation before mutation, malformed addresses and regexes, segment-end
partial reads, and synthetic file-offset rejection. Advertised schemas are
validated in their JSON Schema dialect and successful replies are checked against
their advertised output schemas. Navigation checks cover interior-object cursor
readback and mapped-memory boundaries. Annotation probes verify invalid native
text and duplicate destinations/names before mutation, preserve unselected label
owners, and exercise explicit batch label swaps. Function locals retain observed
names and stack displacements. Graph probes check symbol/interior-address parity
and a source-owned recursive cycle; literal tracing preserves complete queries
and whitespace. Disposable binary copies prove that switching and closing
actually removes the native document, and that CLI byte, function-dossier,
literal-trace results and invalid-address diagnostics agree with MCP.
No provider is mocked in this lane.
Real search probes cover Unicode names, literal metacharacters, case and regex
modes, annotation cache invalidation, complete native fragments of long literals
checked against byte reads, escaped UTF-8/control text, byte-preserving Latin-1
decoding, and Hopper's UTF-16 symbol-name truncation boundary. It verifies native
CallReference classifications across reference and dossier results, retains long
string fragment metadata in dossiers, and exercises pathological regex deadline
and cancellation followed by successful requests in the same native session. When the macOS
Objective-C fixture is present, the lane also verifies native UTF-16 string objects
and their inferred encodings against their actual bytes. Native terminal calls
are checked across reference, instruction, assembly, block-range and procedure-length
projections; block endpoints are normalized using actual native membership.
Exact Objective-C names also exercise named CLI selectors for function, instruction,
decompilation, reference and search operations. A literal `--help` trace query proves
that selector data is preserved independently of global CLI flags.
Unmapped annotation destinations and
oversized later batch names fail before any earlier edit is applied.
The Linux demo lane remains a separate `verify:hopper:linux` command.

`verify:hopper:fat` is a separate macOS lane requiring installed Hopper and the
existing Xcode clang/lipo toolchain. It compiles arm64/x86-64 thin executables and
one- and two-slice FAT32 containers, verifies exact/interior address mappings
against bytes in the original files, checks CLI/MCP parity, and checks owned
runtime cleanup. Source byte changes, removal, permission denial (for non-root
callers), and nonregular replacement must retain native partial mapping facts,
reject unverified original-file coordinates,
and recover after restoration. Single-slice FAT cases also relocate the slice
without changing its loaded bytes. `verify:hopper:fat64` additionally checks
FAT64 preparation through Hopper's native Mach-O loader, source-container
mappings, profile identity,
malformed and ambiguous slice rejection, and temporary-image lifetime. Both
lanes have been verified on Hopper 6.1.0-demo; this establishes REA's prepared
FAT64 workflow, not native FAT64-loader support.
Cross-architecture fixture compilation is not required by `verify:hopper`.

Golden tests use immutable captured text inputs with producer/source provenance
under `tests/fixtures/golden/`. Expected results are reviewed for the semantic
claim; capture commands do not automatically approve new expected outputs.
Do not call handcrafted utility output or synthetic binary builders real-data
goldens. Keep unsupported binary layouts and malformed boundaries as targeted
regressions until a real fixture establishes equivalent coverage.

`verify:browser` exercises source-map failure isolation and expanded-output limits through the compiled CLI and stdio MCP with real Chrome. It also submits five 2 MiB source-map annotations, checks retained script identities and explicit map omissions, and closes its owned fixture target. These public workflows replace redundant metadata-admission assertions; replacement and document-reset boundaries remain focused producer regressions.

`verify:browser` also captures a source-owned noise canvas as a real PNG above
8 MiB through the CLI and stdio MCP, with complete byte/digest parity and real PNG
decoding. Its SDK client explicitly permits the larger inline JSON response;
this lane does not establish large image-comparison request transport coverage.

`verify:browser:network` is a focused real-browser lane for transaction identity,
selected request/response bytes, binary and compressed responses, duplicate
headers, credential and declared-secret redaction, redirects, streaming cutoff,
CLI/MCP parity, and owned-profile cleanup. Set `REA_BROWSER_EXECUTABLE` to an
installed Chrome-family browser. An optional script argument selects an already
installed package's `scripts/rea.mjs` entry point for packaged-artifact checks.
The complete `verify:browser` lane includes these same checks.

After building, `verify:browser:dom` checks empty and HTML-whitespace form
destinations against a native Chrome DOM-property oracle through CLI and stdio
MCP. It requires `REA_BROWSER_EXECUTABLE` and accepts an optional installed REA
entrypoint. The full browser lane includes the same public-adapter assertions
before other fixtures navigate the selected page.

`verify:browser:scripts` checks active script capture → exact-byte export →
existing static JavaScript analysis through CLI and stdio MCP, including
manifest readback, competing query variants, and resolved relative imports.
It uses an installed browser and accepts an optional installed REA entrypoint.
The complete `verify:browser` lane also exercises passive script export through
both public adapters. See [website script export](website-script-export.md).

`verify:browser:modules` compares CLI and stdio MCP traces against an independent
real Chromium module-loading fixture: import-map scopes, package prefixes,
null/backtracking rejection, query/fragment identities, repeated module instances,
lazy and computed unknowns, exact source/map identities and no implicit refetch.
Set `REA_BROWSER_EXECUTABLE`; the optional script argument selects an installed
package entrypoint. The complete `verify:browser` lane and existing conditional
Chrome CI include this verifier. See [module relationships](website-module-trace.md).

## Real-toolchain verification lanes

Each real-toolchain command must require only the host tools needed to prove
its stated claim. Use a host-native fixture for host/provider acceptance, and
place optional cross-target formats or platform-specific runners in separate
commands. Check prerequisites before starting expensive work and name the
missing command, target, and lane in any failure message. A lane must not imply
that a host or target is covered when it was skipped.

Provider admission accepts Ghidra 12.1.x and the JDK range declared by that
installation (`application.java.min` through `application.java.max`). Current
12.1 releases require JDK 21 or newer and set no maximum. The lanes below still
prove behavior on the verified Ghidra 12.1.4 and JDK 21 build.

| Ghidra lane                                | Supported runner/target                                                            | Additional local tools                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run verify:ghidra`                    | Linux x64 ELF or macOS x64/arm64 Mach-O                                            | Host C compiler, Ghidra 12.1.4, and full JDK 21                     |
| `npm run verify:ghidra:switch`             | Linux x64 ELF; GCC/Clang optimized and stripped switch fixtures                    | GCC, Clang, GNU nm/objdump/strip, Ghidra 12.1.4, and full JDK 21    |
| `npm run verify:ghidra:aarch64-jump-table` | Any supported Ghidra host; AArch64 ELF; byte/halfword tables; host ARM64 Mach-O    | Clang with AArch64 target support, Ghidra 12.1.4, and full JDK 21   |
| `npm run verify:ghidra:cross-format`       | Any supported Ghidra host; also analyzes AArch64 ELF, x86-64 PE, and x86-64 Mach-O | `clang`, LLD, and `lld-link` in addition to host-lane prerequisites |
| `npm run verify:ghidra:windows`            | Controlled Windows x64 with native x86-64 PE; `-- --x86` selects native x86 PE     | Ghidra 12.1.4, full JDK 21, and the matching native artifact        |

Windows native conformance runs with `npm run verify:windows-native` and does
not require Ghidra or Java. An optional independently compiled Windows fixture
adds in-place reparse, breakaway, environment, and token observations.
`npm run verify:ghidra:windows:package` additionally packs and installs REA into
an isolated prefix and runs ordinary-user CLI/MCP operations against their
canonical schemas. Run the controlled fixture generator before that lane, or
supply an installed package root and an explicit fixture as arguments.
The host-native Ghidra lane also verifies native value tracing through the
production CLI and a separate stdio MCP process. It compares complete dependency
graphs, validates Evidence and upstream/workflow profiles, checks capability
discovery, and closes the MCP session. No provider or transport is mocked.
It also validates every advertised input/output JSON Schema and the exercised
MCP outputs, probes address spelling and name/address ambiguity, and checks
direct versus targetless calls, byte-read completeness, invalid input diagnostics,
CLI/MCP parity, atomic annotation rollback, refreshed inventories, unchanged
executable bytes, and discarded edits after reopen. A deliberately long temporary
path exercises private Unix socket allocation and cleanup, including cancellation
after a real headless process launches. Native annotation probes reject NUL and
unpaired Unicode surrogates without partial edits or a broken bridge, preserve
supported Unicode and control text, and check lossless malformed-text diagnostics.
Memory-to-file mapping is checked against original artifact bytes.
The fixture also stores a pointer one byte past a function entry; exact
xrefs, raw procedure references, and CLI/MCP dossiers must retain that data edge.
A valid legacy snapshot reconstructs the former omitted edge under its older
profile; CLI and MCP must reject that binding with a mismatch reason and
recovery advice. The rejected open must preserve the active live session.
Exact external entries must resolve while retaining an empty body; unknown
external addresses remain unresolved and external annotations are rejected.
An adversarial regex over a full 12 KB literal must report stack exhaustion as
a resource constraint, preserve live annotations, and allow complete literal
searches afterward; CLI and MCP must agree on both results and recovery advice.
Real snapshot lifecycle checks retain edited API results as Evidence while
rejecting immutable snapshot saves and imports before and after a repeated
open of the same target. They verify unchanged live annotations and run identity,
absent rejected output files, an unchanged source snapshot, and successful
snapshot import/save after closing and recreating the database. The pristine
snapshot is written by an independent real CLI session.
They also start a real annotation and snapshot close concurrently: the edit
must succeed, the snapshot must be rejected without creating a file, and the
edited session must remain usable until explicitly closed.
Source-admission probes change a caller-owned fixture after `open_binary` but
before the first Ghidra query. They require an actionable `artifact_changed`
error preserving both digests and the selected path, unchanged provider
availability, failed-copy cleanup, and successful recovery after reopening.
After import, deleting that source must preserve the captured database identity.
Instruction inspection and containing-function lookup also agree across
hexadecimal case, leading zeros, and encoded default address-space spellings.
The same source-acquisition workflow exercises missing and directory-replaced
inputs, plus real read-permission denial on a non-root host. Root runs report
that permission-denial check as unverified. A focused filesystem integration
check retains selected-platform routing and exclusive creation; two copy/digest
checks duplicated by the real workflow have been removed.
Namespace annotation probes compile a separate host C fixture with C++ ABI
symbols, avoiding a C++ runtime prerequisite. Real Ghidra demangling supplies
duplicate leaf names in two top-level namespaces and a nested namespace. The
workflow verifies leaf and qualified renames, repeated reuse of fully qualified
readback, lookup by the returned name, literal namespace-like leaf names,
rejection of empty qualified leaf names without changing comments, CLI
behavior, and independent CLI/MCP database ownership.
Large-result probes compile initialized host-native data sized from the pinned
MCP SDK receive budget. Real byte reads, annotation edits and function dossiers
exceed that budget while preserving the connection and active analysis run.
Each delivery error must identify its successfully retained Evidence record;
export must recover every source byte and complete annotation, with CLI parity
and an unchanged executable. The focused formatter check retains only the
separate case where recording was not acknowledged.
Malformed annotation readback, memory completeness, and inventory data remain separate
SDK/provider integration cases; success from a real
provider cannot establish rejection of a contradictory provider response.

The Linux switch lane checks dense, sparse-with-holes, shared-body, nonzero,
negative, and nonexact JSON integer labels plus a comparison-only control.
Independent source labels, ELF file bytes, table slots, and bounds branches
define expected case/default destinations. Production CLI and MCP must agree;
debug labels must retain their signed values. For stripped negative fixtures,
the independently checked 32-bit dispatch permits equivalent unsigned labels
only alongside the reported low-confidence `undefined4` parameter; original
source signedness remains unknown and the ABI residual must remain visible.
unsafe labels remain unresolved and every recovered destination is retained.
The compiler oracle also injects malformed records to check that its assertions
reject missing/default-confused labels, wrong destinations, and numeric guesses.
It also invokes the actual bridge methods on detached Ghidra model objects to
check ambiguous dispatches, signed literals, precision bounds, shared targets,
and conflicting labels. This reflection fixture depends on the pinned Ghidra
model and does not claim a compiler produced those synthetic graph shapes.
Pass `--entrypoint /path/to/installed/rea-agents/scripts/rea.mjs` directly to
`scripts/verify-real-ghidra-switch.mjs` to verify an installed package through
the same compiler oracles and CLI/MCP checks.

The cross-format Ghidra lane also analyzes an optimized AArch64 ELF switch
fixture. It checks the recovered case values against the source cases and
requires unresolved table bounds or case mappings to remain visible as
residual unknowns.

`npm run verify:inspector` requires the supported Node.js runtime and installed
REA dependencies. CI runs it on Linux and macOS x64/arm64 and Windows x64. It starts owned loopback
Node Inspector fixtures and verifies discovery and passive observation through
the CLI and stdio MCP, including special filenames, unresolved discovery
locations, and independently resolved loaded scripts. Double-quote filenames
are tested on POSIX only because Windows does not support them.

Inspector adapters live in `src/inspector/`, with loopback fixtures under
`tests/fixtures/inspector/` and forked producer boundaries under
`tests/boundary/inspector/`. The real lane is owned by
`scripts/verify/inspector/runtime-observation.mjs` and
`tests/conformance/inspector/`. Browser and Inspector deliberately share the
existing browser CDP transport/value and file-location helpers. Node fixture
success proves this Inspector workflow on the tested host; it does not prove
Electron GUI behavior or another engine.

## Android APK analysis

`npm run verify:android` requires an existing Java 17+ and an explicit
`REA_JADX_MCP_JAR` for jadx-headless-mcp 0.7.1. Set `REA_ANDROID_TEST_APK` to the
fixed public ApiDemos v6.0.18 fixture. Obtain both with the explicit
`npm run fixtures:android` command; files are SHA-256 verified and
kept under ignored `_reference/`. No Gradle build, Android SDK, emulator or
application execution is required. The lane compares real CLI/MCP package,
class search, class inventory, method decompilation and incoming references.
See [Android analysis](android-analysis.md) for boundaries and resource budgets.
Authenticated IPA and macOS application inventory projection is documented in
[Apple application analysis](apple-application-analysis.md).

The lane and owned-process cancellation helper live in `scripts/verify/android/`.
The explicit downloader and fixed manifest live in `scripts/fixtures/android/`;
their default remains repository-root `_reference/apk-integration/`. Producer
fixtures live in `tests/fixtures/android/`, boundary cases in
`tests/boundary/android/`, and inventory projection composition cases in
`tests/composition/android/`. Real engine success and synthetic protocol success
are separate proof levels.

Synthetic producer regressions run independently:

```sh
npm run test:focused -- tests/boundary/process/jadxIntegration.test.ts tests/boundary/process/androidAnalysisMcp.test.ts
```

## Optional NativeAOT Ghidra analysis

This lane is separate from the default native lane. `build:fixtures:nativeaot`
requires an existing .NET SDK 8.0.416, the platform NativeAOT compiler/linker and
runtime pack 8.0.22. It builds benign sources into ignored `_reference/` and
records independent symbol/directory/SHA oracles; it never executes the target.
Linux also builds stripped, ordinary-native and small malformed/ambiguous/layout
negative inputs. The optional Windows fixture workflow builds a PE on a Windows
runner; analyzing that PE on Linux does not verify a Windows Ghidra host.

Build the clean pinned upstream adapter with `build:ghidra:nativeaot`, then set
`REA_GHIDRA_NATIVEAOT_JAR`. Run `verify:ghidra:nativeaot -- symbols`, `-- stripped`,
`-- ordinary`, `-- unsupported`, `-- malformed`, `-- ambiguous`, and
`-- loader-failure`, and `-- default-native` separately. The loader-failure mode source-builds
a deliberately failing JDK 21 initializer and checks the actual loader cause and
cleanup. The default-native mode verifies ordinary analysis with the optional
extension disabled.
The real MCP lane checks source identity, inline format discovery, metadata
relationships/slots against independent compiler symbols, frozen strings,
pseudocode and owned cleanup. Set `REA_NATIVEAOT_PROOF_CLI=1` for one equivalent
CLI type inspection; this costs an additional full import. Select an unpacked
installed package with `REA_NATIVEAOT_PROOF_PACKAGE_ROOT`, a fixture directory
with `REA_NATIVEAOT_PROOF_FIXTURE_ROOT`, and optional evidence capture directory
with `REA_NATIVEAOT_PROOF_CAPTURE_DIR` (absolute paths).

Keep builds/imports sequential on small hosts; scope `GHIDRA_HEADLESS_MAXMEM`
(e.g. `768M`) to this command and use CPU affinity if needed. REA does not install
or upgrade Java, Ghidra, .NET or native toolchains. See
[the supported layout and provenance](ghidra-nativeaot.md).

## IDA MCP adapter

`npm run verify:ida -- --target /absolute/path/to/program --procedure main`
uses the existing `REA_IDA_MCP_CONFIG` registration. It installs no engine,
Python package, or compiler. The target must already be open in the GUI for
the legacy attached profile; the database-supervisor headless profile opens
a digest-verified private copy. A caller-supplied fixture keeps prerequisites
limited to the selected engine and host. `tests/conformance/ida/inventory.c`
provides an optional small native fixture source with an exported
`rea_fixture_add` function.

The lane invokes the production CLI dispatcher and connects the pinned MCP
client SDK to the production REA server. It verifies function Evidence and
CLI/MCP parity, inventory/search, pseudocode, instructions, xrefs, malformed
input, original-input preservation, and lifecycle cleanup. For headless
analysis it confirms that the owned database IDs disappear from upstream
discovery and private workspaces are removed. For attached analysis it confirms
the existing GUI target remains reachable with the same input identity.
`--package-root` selects an installed/extracted REA artifact. `--report` writes
private local observations with mode `0600`; the console summary contains no
target paths or upstream output.

Adapter and composition tests cover producer parsing, pagination, canonical
entries, external callees, target switches, cancellation draining, snapshot
replay exclusion, ownership failures, and incomplete cleanup. They do not
establish real IDA operation. The initial real workflows cover legacy upstream
1.4.0 on a Windows GUI and the modern supervisor at upstream commit
`c133c3853faa111a9b00ee615c013b720d0c4acd` with Windows x64 IDA 9.3.
Linux/macOS headless, modern attached GUI tools, other engine versions and
architectures remain unverified; see the [provider guide](ida-provider.md).

## DOS Ghidra analysis

`npm run verify:ghidra:dos` requires the supported Ghidra and JDK installation
on Linux x64 or macOS x64/arm64. It generates a source-owned MZ fixture without
a DOS emulator or compiler, then checks real 16-bit decoding, segment
relocation, near/far calls, decompilation, disjoint function body ranges,
stable CLI/MCP observations, unchanged source bytes, and owned process/project
cleanup. Raw p-code address-space selector tokens are reported separately from
the stable observation comparison. Linux x64 and macOS arm64 are verified;
macOS x64 remains unverified. This lane is separate from host-native and optional cross-format
verification. See [DOS analysis](ghidra-dos.md).

`npm run verify:ghidra:com` uses a generated headerless fixture with no compiler,
DOS emulator or game data. It exercises explicit admission, BinaryLoader entry
preparation, measured register context, whole-file byte readback, source offsets,
unmapped PSP/partial reads, actual decompilation, CLI/MCP parity and owned cleanup.
Both segmented-address lanes reject oversized default, explicit-space and encoded-space
coordinates through real reads, function queries and annotation attempts. Rejected
annotations must preserve the live function dossier; CLI and MCP must report the
truncation constraint, while leading-zero coordinates still resolve correctly.
It has the same Ghidra/JDK prerequisites as the MZ lane. Neither lane claims DOS
runtime or PC-98 device execution.

## Apple Interface Builder archives

`npm run verify:interface-builder` compiles the source-owned AppKit XIB into a
real `.nib` with Xcode `ibtool`, wraps it in a temporary app bundle, and runs
the compiled CLI and stdio MCP server with production providers. It compares
their decoded results and checks the view hierarchy, outlet, action, evidence coverage, and truncation
status. Storyboard compilation additionally requires an installed iOS platform.

Keep the provider-specific acceptance path independent from optional
cross-compilers. Cross-format failures belong to the cross-format lane and must
not make native host acceptance unavailable.

## Native platform baseline in CI

CI exercises the pinned Node.js runtime on native hosted runners:

| Host                  | Runner             | Baseline checks                                                                          |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Linux x64             | `ubuntu-latest`    | Installed package and real Node Inspector CLI/MCP                                        |
| Linux arm64 (aarch64) | `ubuntu-24.04-arm` | Installed package and real Node Inspector CLI/MCP                                        |
| macOS 15 arm64        | `macos-15`         | Installed package and real Node Inspector CLI/MCP                                        |
| macOS 15 x64          | `macos-15-intel`   | Installed package and real Node Inspector CLI/MCP                                        |
| Windows x64           | `windows-latest`   | Curated capabilities, native controls, installed package and real Node Inspector CLI/MCP |

Package and Inspector matrices assert the actual Node platform/architecture
before verification and record those values with the Node version. Each matrix
runs at most two jobs concurrently with explicit timeouts and Node heap/thread
limits. Package checks cover installation, CLI/MCP discovery, target-free
analysis, configuration backups/recovery, Evidence and owned lifecycle; Inspector
checks execute source-owned loopback targets and special filename cases.

macOS uses one OS version with one native baseline job per architecture. Each job
runs package and Inspector checks after a single dependency installation. The
separate Inspector matrix covers Linux and Windows; Apple artifact checks retain
their own macOS 15 arm64 job for Xcode-dependent workflows.

These native baseline checks complement the Linux source-test shards and the
separate Apple-artifact and real-provider lanes. Actual Hopper, Ghidra, IDA,
browser and managed-tool claims require their corresponding verification lanes.
Runner labels follow the [GitHub hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Developer commands

Use source feedback while editing, explicit boundary checks for the changed
behavior, and complete CI evidence before merging.

| Command                           | Scope                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run test:local`              | Dirty source tests via the import graph, without build; explicit source paths run regardless of Git status              |
| `npm run test:focused -- PATH...` | Exact existing test files; compiled boundaries build first, and unmatched paths fail                                    |
| `npm run test:changed`            | Source tests affected since the merge base with `origin/main`, including committed and dirty changes                    |
| `npm run test:fast`               | All domain, service, adapter, composition, conformance, and evaluation tests without build                              |
| `npm run test:boundary`           | Boundary, MCP boundary, process boundary, and process-global projects                                                   |
| `npm run test:mcp`                | MCP boundary project                                                                                                    |
| `npm run test:acceptance`         | Complete compiled CLI and MCP acceptance workflows                                                                      |
| `npm run test:watch`              | Dirty source tests in watch mode, without build                                                                         |
| `npm run test:watch:all`          | Changed tests from every project; builds at startup, so rebuild after production edits before relying on compiled tests |
| `npm run check:changed`           | Cached typecheck/lint and branch-related source feedback                                                                |
| `npm run check:pr`                | Opt-in complete local deterministic gate and generated-file checks                                                      |
| `npm run docs:check`              | Generated-document validation from current source and build outputs                                                     |

For example:

```bash
npm run test:local -- src/config.test.ts
npm run test:focused -- tests/acceptance/applications/runtime.test.ts
npm run test:changed -- --base origin/main
npm run test:changed -- --dry-run
```

`test:focused` accepts exact repository-relative test file paths. Source-only
paths do not build; boundary, acceptance, process-global, or unfamiliar `tests/`
paths build conservatively. Tests use Vitest concurrency and isolated
workspaces; commands do not hold a broad test lock. Build and documentation
writers retain checkout-local locks for their shared output files. Explicit
selections do not use `--changed` or permit zero-test success.
The dry-run option reports the chosen merge base, scope and build prerequisite
without executing tests or building. A missing Git base reports how to fetch
it or select another revision.

Changed selection can miss runtime registration, generated data, shell
entrypoints, bridges, or other relationships absent from the import graph.
An empty changed selection means no tests were selected, not verified
correctness. Select relevant boundary files and real-provider lanes explicitly.
Source projects also contain large capacity regressions; `test:fast` promises
no compiled-runtime prerequisite, not a fixed time budget.

Routine iterations and rebases need focused regressions and relevant checks.
Before handing off a PR, run `npm run check` and generated-document checks when
applicable; CI owns the full suite and coverage. Use the full local gate for
broad changes or diagnosing CI, rather than after every edit. Package/install
changes additionally need package verification; provider changes need actual
provider evidence.

Each Vitest project uses up to two workers, bounded by available host parallelism.
Default-group projects can run together. Only `process-boundary` runs in the
later sequence group and serializes its files because process-tree observations
share host sampling resources. Tests that launch the real process harness belong
in `tests/boundary/process/`, including CLI command and environment tests.
Acceptance and process-global files retain isolated
forks but are not serialized; isolation does not imply serial scheduling. CI uses
the same per-project worker bound.
The pure domain/contracts and recording-port service projects share one worker
module context because their tests own no mutable runtime resources. MCP
boundary files also share the immutable server module graph while creating and
closing independent in-memory sessions. Adapter, composition, acceptance,
process-global, and other boundary projects retain per-file isolation.
Build and documentation writers use checkout-local locks for their respective
output files. `npm test` delegates its build to the build lock; the Vitest suite
does not hold a test-command lock. `check:pr` runs its test task before starting
generated-document validation.

Vitest and Node persistent compile caches are deliberately not enabled by
default. To evaluate repeated local runs, opt in for both cold and warm
measurements with an isolated cache:

```bash
NODE_COMPILE_CACHE=.cache/node-compile npm test
```

Do not report the warm result as a cold-suite improvement, and do not enable
the cache in coverage or benchmark CI without first showing that its
instrumentation remains equivalent.

## Coverage and timing

CI owns coverage. The aggregate floors are 65% statements, 60% branches, 60%
functions, and 68% lines. `src/domain/**` must reach 80% statements, 75%
branches, 75% functions, and 80% lines. `src/contracts/**` must reach 85%
statements, 80% branches, 80% functions, and 85% lines. Thresholds are
glob-specific rather than per-file and are never updated automatically.
Coverage does not replace named boundary, acceptance, or real-provider scenario
matrices.

CI runs four native Vitest shards without retries. Each shard emits a blob
report; the merge job produces aggregate coverage plus JUnit and JSON timing
reports, uploads them together, and writes the slowest files to the workflow
summary. Static checks, documentation, build, package verification, and
real-system lanes remain separate jobs so one kind of evidence cannot stand in
for another.

The PR acceptance target is a median `npm run check:pr` wall time below three
minutes across three warm-build runs on the benchmark host. Keep Vitest caches
cold unless separately identified. A PR that touches packaging or real-system
behavior requires the applicable `verify:*` lanes; packaging and installation
changes also require `npm run verify:package`. The full-gate benchmark measures
that explicit lane, not the routine iteration requirement.

## Apple native metadata and UI

`npm run verify:apple-dispatch` compiles the Objective-C fixture (classes,
protocols, a property and an `NSString` category) and the Swift
conformance/vtable fixture.

- Each fixture is linked with legacy `LC_DYLD_INFO` binds and with chained
  fixups; on Apple silicon the ObjC fixture is also built as arm64e, which uses
  authenticated pointers.
- The lane inspects the bytes and repeats after stripping local symbols.
- It requires the bound `NSObject` superclass, the external category, and the
  matching `pointer_fixups` coverage. It requires macOS and the host Xcode toolchain; targets are not
  executed. `npm run verify:native-ui` launches exactly one source-owned fixture
  window and requires successful selected-window capture and selected actions.
  An OS permission denial fails the positive lane. `npm run verify:native-ui:permissions`
  allows a host-permission-boundary-only result and explicitly reports
  `positive_e2e: false`; it must not be reported as capture/action proof.
  Both commands reject a changed executable digest and clean up the fixture
  process and helper. These lanes require an interactive macOS desktop. See [native investigation](native-investigation.md)

`npm run verify:native-calls` needs macOS with Command Line Tools (`clang`,
`lldb`, `codesign`, `nm`) and Developer Mode enabled for unattended debugger
access. Preflight reports disabled Developer Mode without changing host settings.
It compiles `tests/conformance/native/calls.m` and
runs `observe-native-calls` through the CLI and stdio MCP. It checks:

- the receiver class, selector and argument registers of every entry, and that
  breakpoint addresses equal `nm`'s symbol addresses;
- captured stdout and an environment override, plus a 2 MiB flood on each
  output stream with bounded retained prefixes and exact drained-byte counts;
- the event-limit and duration outcomes, with the process confirmed gone;
- that a hardened-runtime copy is refused with `debugger-attach-denied`, and
  that the same copy signed with `get-task-allow` is traced.

### Firmware adapters

`npm run fixtures:firmware` uses existing Python 3 and a host C compiler to make
an ignored gzip/USTAR firmware fixture and independent offset/hash oracle.
`npm run verify:firmware` requires caller-supplied Binwalk 3.1.0, Unblob 26.6.4
and util-linux prlimit on Linux. The provider also accepts other 3.1.x and
26.6.x builds and reports them as unverified; this lane proves the audited
releases. It verifies CLI/MCP parity, selected ranges,
unknown chunks, depth limits and extracted child digests. The optional
`REA_FIRMWARE_VERIFY_EXT4=1` lane requires existing mke2fs/debugfs; the separate
`REA_FIRMWARE_VERIFY_GHIDRA=1` lane checks a selected host ELF through real Ghidra.
Neither optional toolchain is a base-lane prerequisite. See
[firmware analysis](firmware-analysis.md) for limits and unverified formats.

The real entrypoint is `scripts/verify/firmware/analysis.mjs`; the fixture runner
and unchanged Python producer belong together in `scripts/fixtures/firmware/`.
Producer fixtures and boundaries remain in `tests/fixtures/firmware/` and
`tests/boundary/firmware/`. Source-fixture generation proves the runner and
independent oracle; actual Binwalk/Unblob CLI/MCP proof requires selected tools.

### JavaScript source recovery

Build once with `npm run build:cached`, then run `npm run verify:javascript:recovery`.
This focused lane requires Linux x64, util-linux `prlimit`,
`REA_WAKARU_COMMAND` pointing to the official Wakaru 1.13.0 Linux x64 binary,
and `REA_JAVASCRIPT_FIXTURE_TOOLS` pointing to an isolated npm prefix containing
esbuild 0.25.10 and webpack 5.101.3. No global installation is required.
The lane compiles source-owned fixtures, exercises CLI and stdio MCP, verifies
published bytes and provenance, feeds recovered modules into existing analysis,
and compares a finite set of known fixture results. It does not establish
arbitrary recovered-application equivalence. CI installs these prerequisites only
in `.github/workflows/real-javascript-recovery.yml`; the existing `real-browser`
lane uses real Chrome for browser capture and website workflows.

### Captured website source-map lane

`npm run verify:browser:source-maps` checks actual Chromium capture/export and
source-map point tracing through CLI and stdio MCP. It requires absolute
`REA_BROWSER_EXECUTABLE` and `REA_WEB_SOURCE_MAP_COMPILER` pointing to esbuild
0.25.10's `lib/main.js` in a caller-owned isolated installation. Preflight reports
missing prerequisites for this lane. The compiler is used only to generate the
source-owned fixture. No Hopper, Ghidra or application dependency installation
is required.

```bash
REA_BROWSER_EXECUTABLE=/absolute/path/to/chromium \
REA_WEB_SOURCE_MAP_COMPILER=/absolute/path/to/fixture-tools/node_modules/esbuild/lib/main.js \
npm run verify:browser:source-maps
```

`scripts/verify-browser-source-maps.mjs /absolute/path/to/installed/rea.mjs`
checks an installed package after building the verifier dependencies. The separate
conditional `real-web-source-map` CI job supplies Chrome and an isolated pinned
fixture compiler; static/unit checks do not acquire a browser. See
[the source location guide](web-source-location.md) for the verified decoder profile.

### JavaScript large-output lane

`npm run verify:javascript:output` exercises the CLI JSON result surface beyond
the running Node engine's single-string limit. Shared input leaves keep the
fixture's graph small; the verifier writes one temporary output file, checks its
complete byte count and an independent digest, then removes it. It requires only
Node and the built REA runtime, with space for the output plus a 1 GiB reserve.
Run `npm run verify:javascript:output -- jsonl` for compact JSONL coverage. This
opt-in lane is separate from routine tests and the canonical hash check
`npm run verify:javascript:digests`. It verifies serialization rather than an
arbitrary third-party application's parsing cost or MCP client capacity.

### Website runtime attribution lane

`npm run verify:browser:runtime` uses caller-supplied
`REA_BROWSER_EXECUTABLE` and an owned synthetic site/profile. It exercises public
CLI and stdio MCP for precise execution and native listener source locations,
including actual armed progress, Unicode/CRLF digests, repeated source URLs with
distinct script IDs, zero branches and function-only unknowns on repeated
coverage, request initiators and an externally owned page that remains open.

An optional entrypoint argument to `scripts/verify-browser-runtime.mjs` runs the
same checks through an isolated installed package. The conditional
`real-web-runtime` CI job runs only for relevant changes and needs no fixture
compiler. Ordinary unit/static gates acquire no browser. See
[website runtime attribution](web-runtime.md) for effects, resource bounds and
coverage limits.

### Offline binary layout

`npm run verify:binary:layout` requires Linux x64, GCC/binutils, absolute
`REA_PWNTOOLS_PYTHON` with pwntools 4.15.0/pyelftools 0.33/Unicorn 2.1.2 and
absolute `REA_VERIFY_STRACE_COMMAND`. It compiles ephemeral source-owned ELF
fixtures and checks public CLI/MCP, lossless addresses/names, file ranges,
mitigation inferences, malformed/unsupported input, original file hashes and
released process ownership. Exec syscall tracing must identify only the declared
Node/Python launchers; no target binary is executed. Core/debugger claims need
separate verification lanes. Pass an installed package entrypoint as the script's
first argument to verify packaging independently of the checkout.
The valid SHN_XINDEX fixture has 65,281 full section rows; CLI is checked in
the ordinary lane. Its large MCP transfer is opt-in with
`REA_VERIFY_LARGE_ELF_MCP=1` (or the workflow dispatch `large_mcp` input), an
explicit 256 MiB SDK receive buffer and five-minute request timeout. Ordinary
MCP fixtures retain the pinned SDK defaults.

### Offline EVM interface

`npm run verify:evm:interface` requires Linux x64, an absolute
`REA_VERIFY_STRACE_COMMAND`, caller-supplied util-linux `prlimit` and `REA_VERIFY_SOLC_MODULE` selecting the absolute module path for
solc 0.8.30. It compiles source-owned plain/optimized/via-IR Cancun fixtures in
private storage and checks actual CLI/MCP selector evidence, raw/hex identity,
unknowns, malformed carriers and independent cleanup. An optional positional
entrypoint verifies a fresh installed package. It acquires no engine, compiler
or chain dependency and does not execute a contract on a chain.

### Recorded crash evidence

`npm run verify:recorded:crash` is a separate Linux x64 lane. It requires GCC,
GDB, absolute `REA_PWNTOOLS_PYTHON` with the offline ELF profile above,
`REA_PWNDBG_GDBINIT` and `REA_PWNDBG_VENV_PATH` with unchanged pwndbg 2026.09.15,
and `REA_VERIFY_STRACE_COMMAND`. Its disposable CI runner installs GDB, checks out the exact upstream
commit and installs its frozen lockfile in isolated runner storage. No developer
host configuration or core-pattern setting changes.

Fixture generation explicitly runs an owned source-built two-thread program
under GDB to create a recording. Subsequent public CLI/MCP inspection verifies
lossless high registers, signed signals, note source bytes, malformed/missing
notes, unfamiliar owners, optional core-only mapping context and actionable
missing/unsupported plugin errors. A historical-PID collision fixture references
an owned live sentinel; inspection syscall traces reject process attach/memory
access, provider lookups of that PID's `/proc` files and attempted Internet sockets. Traces admit
the observed upstream startup helpers (`iconv -l`, the selected checkout's Git
version lookup) and REA ownership inspection separately from target execution.
This is fixture evidence, not a sandbox claim. Inputs remain unchanged and the
sentinel must stay alive; owned cleanup and empty verifier descendants are required. Pass an
installed package entrypoint as the script's first argument for package coverage.

## Agent evaluation and conformance records

Evaluate native, JavaScript, managed and browser investigation tasks through a
real local Codex CLI with:

```bash
npm run verify:agent
```

Its report records tool selection, repeated calls, token use, completion quality,
and handling of permissions and unknowns.

Regenerate the managed conformance manifest and Evidence completion ledger from
live verification results, or check them for drift:

```bash
npm run evidence:generate
npm run evidence:check
```

The records preserve unsupported and unverified coverage as explicit unknowns.
Run the matching real-tool prerequisites described in this guide.
