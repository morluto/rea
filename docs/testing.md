# Testing REA

Prefer evidence in this order: full end-to-end workflows with real production
providers, integration tests across data/API boundaries, then golden regressions
from real captured inputs. Keep focused module tests for distinct failure or
semantic cases that these workflows cannot reliably reproduce. A test's path
or suite name does not establish its behavioral depth.

Tests are grouped into Vitest projects so ownership, allowed dependencies and
runtime cost are visible from their paths. Before pruning a test, identify the
replacement scenario and its assertions; passing success journeys do not
replace malformed input, cancellation, permission or cleanup coverage.

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

Real Hopper, Ghidra, browser, package, and managed-code claims belong to their
explicit `npm run verify:*` lanes. The reconstruction-readiness lane also
checks deterministic rerun, tamper, and stale-input handling; those checks do
not execute extracted JavaScript modules. When application runtime behavior is
needed, exercise the actual target through browser, Electron, or process
capture. Real model trials are manual; Vitest covers deterministic evaluator
logic.

## End-to-end, integration and golden evidence

Full E2E tests invoke the production command dispatcher and real providers,
without fake launchers, runners or responses. `verify:keyed-archive` writes an
actual Foundation binary archive, runs the CLI and a separate stdio MCP
subprocess, checks parity and pagination, rejects an escaping path and checks
an XML graph golden. `verify:asset-catalog` compiles source-owned colors with
`actool`, invokes real `assetutil`, then checks CLI/MCP results, exact catalog
digest, every raw metadata field, pagination and malformed input rejection.
Neither artifact workflow requires Hopper or launches it. Both run in macOS CI.

MCP SDK transport tests with recording providers remain integration tests.
They are useful for schema drift and failure projection but do not prove that
Hopper, Ghidra or another substituted engine works. `verify:package` proves
packaging/install behavior and fake-provider integration; use the corresponding
real-provider lanes for engine claims. Real Apple dispatch and Interface
Builder verifiers currently prove format integration through production readers.

Golden tests use immutable captured text inputs with producer/source provenance
under `tests/fixtures/golden/`. Expected results are reviewed for the semantic
claim; capture commands do not automatically approve new expected outputs.
Do not call handcrafted utility output or synthetic binary builders real-data
goldens. Keep unsupported binary layouts and malformed boundaries as targeted
regressions until a real fixture establishes equivalent coverage.

`verify:browser` also captures a source-owned noise canvas as a real PNG above
8 MiB through the CLI and stdio MCP, with complete byte/digest parity and real PNG
decoding. Its SDK client explicitly permits the larger inline JSON response;
this lane does not establish large image-comparison request transport coverage.

The [test suite audit](test-suite-audit.md) records the pruning decisions,
replacement evidence and remaining priorities.

## Real-toolchain verification lanes

Each real-toolchain command must require only the host tools needed to prove
its stated claim. Use a host-native fixture for host/provider acceptance, and
place optional cross-target formats or platform-specific runners in separate
commands. Check prerequisites before starting expensive work and name the
missing command, target, and lane in any failure message. A lane must not imply
that a host or target is covered when it was skipped.

| Ghidra lane                                | Supported runner/target                                                            | Additional local tools                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run verify:ghidra`                    | Linux x64 ELF or macOS x64/arm64 Mach-O                                            | Host C compiler, Ghidra 12.1.4, and full JDK 21                     |
| `npm run verify:ghidra:switch`             | Linux x64 ELF; GCC/Clang optimized and stripped switch fixtures                    | GCC, Clang, GNU nm/objdump/strip, Ghidra 12.1.4, and full JDK 21    |
| `npm run verify:ghidra:aarch64-jump-table` | Any supported Ghidra host; AArch64 ELF; byte/halfword tables; host ARM64 Mach-O    | Clang with AArch64 target support, Ghidra 12.1.4, and full JDK 21   |
| `npm run verify:ghidra:cross-format`       | Any supported Ghidra host; also analyzes AArch64 ELF, x86-64 PE, and x86-64 Mach-O | `clang`, LLD, and `lld-link` in addition to host-lane prerequisites |
| `npm run verify:ghidra:windows`            | Controlled Windows x64 with native x86-64 PE                                       | Ghidra 12.1.4, full JDK 21, and the matching native artifact        |

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
REA dependencies. CI runs it on Linux and Windows. It starts owned loopback
Node Inspector fixtures and verifies discovery and passive observation through
the CLI and stdio MCP, including special filenames, unresolved discovery
locations, and independently resolved loaded scripts. Double-quote filenames
are tested on POSIX only because Windows does not support them.

## Android APK analysis

`npm run verify:android` requires an existing Java 17+ and an explicit
`REA_JADX_MCP_JAR` for jadx-headless-mcp 0.7.1. Set `REA_ANDROID_TEST_APK` to the
fixed public ApiDemos v6.0.18 fixture. Obtain both with the explicit
`npm run fixtures:android` command; files are SHA-256 verified and
kept under ignored `_reference/`. No Gradle build, Android SDK, emulator or
application execution is required. The lane compares real CLI/MCP package,
class search, class inventory, method decompilation and incoming references.
See [Android analysis](android-analysis.md) for boundaries and resource budgets.

Synthetic producer regressions run independently:

```sh
npm run test:focused -- tests/boundary/android/jadxIntegration.test.ts tests/boundary/mcp/androidAnalysisMcp.test.ts
```

## DOS Ghidra analysis

`npm run verify:ghidra:dos` requires the supported Ghidra and JDK installation
on Linux x64 or macOS x64/arm64. It generates a source-owned MZ fixture without
a DOS emulator or compiler, then checks real 16-bit decoding, segment
relocation, near/far calls, decompilation, disjoint function body ranges,
stable CLI/MCP observations, unchanged source bytes, and owned process/project
cleanup. Raw p-code address-space selector tokens are reported separately from
the stable observation comparison. Linux x64 is verified; macOS DOS remains
unverified. This lane is separate from host-native and optional cross-format
verification. See [DOS analysis](ghidra-dos.md).

`npm run verify:ghidra:com` uses a generated headerless fixture with no compiler,
DOS emulator or game data. It exercises explicit admission, BinaryLoader entry
preparation, measured register context, whole-file byte readback, source offsets,
unmapped PSP/partial reads, actual decompilation, CLI/MCP parity and owned cleanup.
It has the same Ghidra/JDK prerequisites as the MZ lane. Neither lane claims DOS
runtime or PC-98 device execution.

## Apple Interface Builder archives

`npm run verify:interface-builder` compiles the source-owned AppKit XIB into a
real `.nib` with Xcode `ibtool`, wraps it in a temporary app bundle, and checks
the decoded view hierarchy, outlet, action, evidence coverage, and truncation
status. Storyboard compilation additionally requires an installed iOS platform.

Keep the provider-specific acceptance path independent from optional
cross-compilers. Cross-format failures belong to the cross-format lane and must
not make native host acceptance unavailable.

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
| `npm run docs:check`              | Committed generated-document freshness                                                                                  |

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

Local full-suite Vitest runs use up to two workers and schedule projects one
at a time. Process, acceptance and process-global projects serialize their
files to prevent competing lifecycle observations. CI retains its two-worker
budget.
The pure domain/contracts and recording-port service projects share one worker
module context because their tests own no mutable runtime resources. MCP
boundary files also share the immutable server module graph while creating and
closing independent in-memory sessions. Adapter, composition, acceptance,
process-global, and other boundary projects retain per-file isolation.
`npm test`, `npm run docs:check`, and `npm run docs:generate` share
repository-local locks and fail fast when the same class of command is already
running. The `npm test` build is inside that lock. `check:pr` runs its test task
before starting generated-document validation.

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

`npm run verify:apple-dispatch` compiles Objective-C class/protocol and Swift
conformance/vtable fixtures, inspects their bytes and repeats after stripping
local symbols. It requires macOS and the host Xcode toolchain; targets are not
executed. `npm run verify:native-ui` launches exactly one source-owned fixture
window and requires successful selected-window capture and selected actions.
An OS permission denial fails the positive lane. `npm run verify:native-ui:permissions`
allows a host-permission-boundary-only result and explicitly reports
`positive_e2e: false`; it must not be reported as capture/action proof.
Both commands reject a changed executable digest and clean up the fixture
process and helper. These lanes require an interactive macOS desktop. See [native investigation](native-investigation.md)
for the exact ABI, authority, graph and observation boundaries.
