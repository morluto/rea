# Testing lanes and provider verification

For test design and developer commands, see [Testing REA](testing.md).

## Real-toolchain verification lanes

Linux Rizin debugger ownership changes require a separate real-provider gate on
Rizin 0.7.4. Run
`npm run test:focused -- tests/boundary/providers/RizinInferiorTty.test.ts`.
This test verifies the caller-selected TTY against the actual inferior's file
descriptors, confirms `dbg.exitkills=false`, detaches through the `olj`/`o-`
protocol, and checks that the target survives debugger close and writes to the
selected TTY. The suite is included in the reverse-tools Vitest and mutation
typecheck selections; its real-provider assertions skip when Rizin 0.7.4 is
unavailable. Run the focused command above on a host with that provider for the
explicit real-provider verification gate.

Each real-toolchain command must require only the host tools needed to prove
its stated claim. Use a host-native fixture for host/provider acceptance, and
place optional cross-target formats or platform-specific runners in separate
commands. Check prerequisites before starting expensive work and name the
missing command, target, and lane in any failure message. A lane must not imply
that a host or target is covered when it was skipped.

Provider admission accepts Ghidra 12.x (>=12.1) and the JDK range declared by that
installation (`application.java.min` through `application.java.max`). Current
12.1 releases require JDK 21 or newer and set no maximum. The lanes below still
prove behavior on the verified Ghidra 12.1.4 and JDK 21 build.

| Ghidra lane                                | Supported runner/target                                                                                          | Additional local tools                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run verify:ghidra`                    | Linux x64/arm64 ELF or macOS x64/arm64 Mach-O                                                                    | Host C compiler, Ghidra 12.1.4, and full JDK 21                             |
| `npm run verify:ghidra:seeds`              | POSIX; raw x86 fixture; seed ordering, BSS labels, analyzer readback, not-applicable and unknown analyzer names  | Ghidra 12.1.4 and full JDK 21                                               |
| `npm run verify:ghidra:swift`              | macOS x64/arm64 Mach-O                                                                                           | Host Swift compiler, Ghidra 12.1.4, and full JDK 21                         |
| `npm run verify:ghidra:riscv`              | Linux/macOS x64/arm64 host; source-owned RV32/RV64 double-float and RV32 ilp32 ELF through CLI and MCP           | RISC-V Clang, LLD, LLVM readelf and objdump, Ghidra 12.1.4, and full JDK 21 |
| `npm run verify:ghidra:switch`             | Linux x64 ELF; GCC/Clang optimized and stripped switch fixtures                                                  | GCC, Clang, GNU nm/objdump/strip, Ghidra 12.1.4, and full JDK 21            |
| `npm run verify:ghidra:aarch64-jump-table` | Any supported Ghidra host; AArch64 ELF; signed/unsigned byte/halfword tables; host ARM64 Mach-O                  | Clang with AArch64 target support, Ghidra 12.1.4, and full JDK 21           |
| `npm run verify:ghidra:cross-format`       | Any supported Ghidra host; also analyzes AArch64 ELF, x86-64 PE, and x86-64 Mach-O                               | `clang`, LLD, and `lld-link` in addition to host-lane prerequisites         |
| `npm run verify:ghidra:windows`            | Controlled Windows x64 with native x86-64 PE; `-- --x86` selects native x86 PE                                   | Ghidra 12.1.4, full JDK 21, and the matching native artifact                |
| `npm run verify:ghidra:dol`                | Any supported Ghidra host; source-owned PowerPC GameCube DOL fixture built from a linker script (never executed) | Clang with PowerPC target, LLD, GNU readelf, Ghidra 12.1.4, and full JDK 21 |

The optional Swift lane compiles a source-owned fixture and checks modern and
provider-demangled procedure names through real stdio MCP, with and without the
dSYM companion. It checks unfiltered, structs, and literal-name filters,
same-address alias evidence, deduplication, and explicit unresolved categories.
It does not add a Swift prerequisite to the host C fixture lane.

The host lane also verifies namespaced C++ ABI symbols and annotation identity.
That facet requires Ghidra's matching `demangler_gnu_v2_41` native component in
`GPL/DemanglerGnu/os/<platform>/` or `build/os/<platform>/`, in addition to the
native decompiler. The namespace verifier reports missing or non-executable
components before testing the fixture. REA does not build or install them.

Windows native conformance runs with `npm run verify:windows-native` and does
not require Ghidra or Java. It includes Job Object commit-limit controls (a
limited child that reaches the limit, a control that does not, and invalid
limit rejection). An optional independently compiled Windows fixture
adds in-place reparse, breakaway, environment, and token observations.
The separate `scripts/verify-windows-native-inspection.mjs` lane uses the
`.cache/windows-native-inspection-fixture` artifact built on Linux with
`node scripts/build-windows-native.mjs --inspection-fixture`. Its controlled
first deletion failure checks retained NTFS ownership across a same-volume
rename, later-query handle-based recovery, successful-admission caching, and
environment-teardown cleanup. It neither
establishes the cause of the intermittent #1701 host failure nor replaces
verification with the shipped production artifact.
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
inputs, plus real read-permission denial on a host that enforces it. Permission
fixtures must probe the relevant read, write or search operation before relying
on POSIX mode bits: a non-root Linux process may bypass DAC through capabilities.
`requirePermissionDenial` reports an explicit skip when the host permits the
probe; it restores the probe's permissions before skipping. Such a skip leaves
real permission coverage unverified. Filesystem integration separately checks
selected-platform routing and exclusive creation.
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
Successful-result and oversized-error delivery constraints must identify their
successfully retained Evidence records;
export must recover every source byte, complete annotation and original error
diagnostic, with CLI parity
and an unchanged executable. Formatter integration separately checks unacknowledged Evidence recording.
Long ordinary procedure names and encoded address-space selectors must produce
normal validation errors without exhausting Java's regex stack or losing the
private bridge connection. Each rejection is followed by a real provider lookup;
address-like literal names still resolve exactly after annotation.
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

Node Inspector verification does not establish Electron GUI or other engine
behavior. Browser and Inspector share CDP transport/value and file-location
helpers; their producer workflows remain distinct.

## Android APK analysis

The real Android lane also runs on Windows x64 with its matching bundled native
controls. It verifies bidirectional protocol input, CLI/MCP result parity,
real MCP cancellation/disconnect and Java exit after abrupt CLI owner
termination. The forced Windows exit does not exercise the POSIX SIGTERM
handler and can leave temporary workspace files. `verify:windows-native`
separately checks binary input, backpressure, EOF and pending-write job closure.

`npm run verify:android` requires an existing Java 17+ and an explicit
`REA_JADX_MCP_JAR` for jadx-headless-mcp 0.7.1. Set `REA_ANDROID_TEST_APK` to the
fixed public ApiDemos v6.0.18 fixture. Obtain both with the explicit
`npm run fixtures:android` command; files are SHA-256 verified and
kept under ignored `_reference/`. No Gradle build, Android SDK, emulator or
application execution is required. The lane compares real CLI/MCP package,
class search, class inventory, method decompilation and incoming references.
See [Android analysis](android-analysis.md) for boundaries and resource budgets.

The **Real Android metadata bridge** workflow compiles the Java bridge and runs
its metadata regressions against the same checksum-pinned engine and public APK.
It runs on branch pushes affecting its bridge, fixture or engine inputs, and can
also be dispatched manually or called by another workflow. It uses the runner's
JDK with two active processors and a 512 MiB heap; it needs no npm dependency
installation. This lane checks exact raw/display class selectors, raw member names and field
DEX types used by mapping lookups, and the existing cold-metadata regressions. It does not establish CLI/MCP parity or application
execution behavior. The broader `verify:android` lane checks CLI/MCP parity;
neither lane runs the APK.

`verify:jeb` requires a caller-started JEB client serving MCP at
`REA_JEB_MCP_URL` (default `http://127.0.0.1:8425/mcp`) with a project
already open, and exercises shared application/provider client inspection, unit listing coverage,
and method decompilation. The script records the engine's exact response to
`open_jeb_project`; the earlier licensed 5.48.0 headless verification did not
advertise that tool.
REA does not install or launch JEB; see [JEB analysis](jeb-analysis.md) for
the bring-your-own boundary. The earlier licensed build was verified against JEB 5.48.0 serving
`jeb-mcp-server` 1.3.0 at four scales: a compiled Java class fixture, a
locally built signed probe APK with a launcher activity (manifest, v1/v2/v3
certificates, dex bytecode, filtered and paginated listing), the published
Signal 8.30.3 universal release APK (109 MB, R8-processed Kotlin/Compose,
four signature schemes, native arm64 ELF units) with MainActivity method
decompilation through both CLI and MCP, and the official Flutter Gallery
2.9.2 release APK (112 MB): per-ABI `libapp.so` Dart AOT snapshot images
analyzed as native code (75k methods on arm64) and decompiled through both
CLI and MCP with explicit unit selection, plus the thin Java wrapper and
decoded manifest. The dedicated Dart snapshot processor and `run_script`
remained GUI-only surfaces in that headless build.
The separate [Linux CE native audit](https://github.com/morluto/rea/blob/42e1a17d6e6c0487f17be0bae248553c4caba7f7/experiments/analysis-efficiency/jeb-linux-native.md)
uses the official CE `5.48.0.202610071539` direct CLI launcher and real
CLI/stdio MCP ELF workflows. That audit does not qualify CE Java/Android
decompilation or GUI project opening, and it does not replace the licensed
verification above.
Authenticated IPA and macOS application inventory projection is documented in
[Apple application analysis](apple-application-analysis.md).

`npm run verify:harmony` requires no SDK or engine. It projects the pinned
harmony-next-pipeline 1.0.1 release HAP from an MIT-licensed source repository,
fetched by `npm run fixtures:harmony` into ignored
`_reference/harmony-integration/`, set as `REA_HARMONY_TEST_HAP`.
The lane exercises `inspect_artifact`, projection determinism, Stage-model
path hints, exact component sets, signing-entry limitations, and CLI/MCP parity.
The release artifact has no independently established compiler/SDK or
reproducible source build; the default lane does not verify an installed package.
See [HarmonyOS package inventory](harmony-analysis.md) for those proof boundaries.
HarmonyOS `.har` libraries are deliberately not suffix-classified because
`.har` also names HTTP Archive JSON.

Synthetic producer regressions run independently:

```sh
npm run test:focused -- tests/boundary/process/jadxIntegration.test.ts tests/boundary/process/androidAnalysisMcp.test.ts tests/boundary/process/androidMappingMcp.test.ts
```

## Apktool resource decoding

`npm run verify:apktool -- --apk PATH` exercises both Apktool operations
against a real launcher (`REA_APKTOOL_COMMAND` or PATH) and one APK. No
download or build step is involved. Record: apktool 2.7.0-dirty (Debian
packaging) on Linux with OpenJDK 25, against a signed aapt2-built probe APK
carrying two resource locales — launcher version, on-disk digest agreement
with the reported target identity, apktool.yml metadata projection
(1.2.3, SDK 24–34), manifest package agreement, and both the default and
`de` string tables projected through the locale option. Parser goldens in
`src/apktool/ApktoolDecodeOutput.test.ts` come from the same decode. See
[Apktool resource analysis](apktool-resource-analysis.md) for boundaries and
budgets.

## Flutter build identification

`npm run verify:flutter -- --apk PATH [--plain-apk PATH]` runs both pure
static operations against a real Flutter APK, plus an optional non-Flutter
APK for the negative check. No engine or external tool is involved. Record:
Flutter Gallery 2.9.2 (112 MB, arm64-v8a / armeabi-v7a / x86_64) — every
ABI reports the same agreeing snapshot hash
(`65817c30a78bb44c3dc3771876b6010a`, two sections each) read 20 bytes after
the Dart snapshot magic, per-ABI engine GNU build-ids, no labeled Dart
version string (expected for a release engine build), and the Android
clang/LLVM toolchain line; the AOT inspection locates all four snapshot
symbols through the dynamic symbol table on both ELF64 and ELF32 images,
validates the data-section headers, agrees with the identification hash,
and counts 756 `package:` and 201 `dart:` URIs on arm64-v8a and x86_64,
and 212 / 48 on armeabi-v7a, from each isolate data section. Responses
retain at most 500 URIs per family and 2000 class-like tokens. Gallery's
pool projection and overall AOT coverage are partial while its structural
`libapp.coverage` is complete. A plain aapt2-built APK reports not-detected with
complete coverage. The suite uses self-contained synthetic ELF images and recorded scanner
prefixes, with no private local-file dependency. The verifier now compares
compiled CLI and stdio MCP Evidence on every ABI, including data-header kind
and declared lengths. Add
`--expectations scripts/fixtures/flutter-gallery-expectations.json` for the
documented Gallery APK to assert its pinned digest, hash, exact engine labels
and per-ABI URI counts. The verifier requires complete structural snapshot
coverage, reports bounded pool coverage as partial/unverified, and reports
exact labels/counts on other APKs unverified without an expectations file.
See [Flutter build identification](flutter-analysis.md) for boundaries and
budgets.

## ADB device acquisition

`npm run verify:adb` exercises ADB observation and transfer operations against a live device or
emulator through the caller's adb binary (`REA_ADB_PATH` or PATH). No SDK
installation or emulator management is involved. `--install-apk` is unavailable
until the selected APK identity and device cleanup ownership can be established
safely. The transfer probe creates and removes a temporary device file. `--pull`
acquires a real package and re-digests the pulled files on
disk against the returned SHA-256 values; `--serial` selects a device when
several are attached.

Record: adb 34.0.5-debian on Linux against an Android 14 (API 34) x86_64
emulator. The lane covered the complete observation surface — 337-process
listing, 287 binder services including AIDL `/`-suffixed names, 92 features
including hex GL versions, display size/density, window focus (legitimately
null on headless devices), `settings get global adb_enabled`, bounded
logcat, directory listings — plus a real two-APK split set
(`base.apk` plus `split_probe.apk`, built and installed through
`install-multiple`) pulled with byte-exact digests, a push/pull roundtrip
verified by the device's own sha256sum, a 1.3 MB screen capture with PNG
dimensions, `dumpsys package` projection, and the full lifecycle: unique
resolution before launch, launcher-activity start through
`cmd package resolve-activity` with `am start -W`, the started app visible
in the process listing, force-stop, uninstall, and zero matches after
removal. System-package pulls whose APKs keep non-`base.apk` names report
the `unknown` role with the file-name basis, verified with
`com.android.settings` (single 73.9 MB APK). Parser goldens for
`adb devices -l`, `getprop`, `pm list packages -f`, and `pm path` come from
the same device. See [ADB device analysis](adb-device-analysis.md) for
boundaries and budgets.

## Optional NativeAOT Ghidra analysis

The source parser lane is independent of the optional annotation JAR. Its
synthetic RTR 9.1 PE golden checks captured-byte digest admission, rehydration
into an immutable parser overlay, MethodTable/slot relationships, and frozen
literal extraction; provider tests exercise `inspect_native_load_image` and
address-based `inspect_native_data_type` with the database result still
unavailable. These tests do not establish Windows Ghidra host behavior.

This lane is separate from the default native lane. `build:fixtures:nativeaot`
requires an existing .NET SDK 8.0.416, the platform NativeAOT compiler/linker and
runtime pack 8.0.22. It builds benign sources into ignored `_reference/` and
records independent symbol/directory/SHA oracles; it never executes the target.
Linux also builds stripped, ordinary-native and small malformed/ambiguous/layout
negative inputs. The optional Windows fixture workflow builds a PE on a Windows
runner; analyzing that PE on Linux does not verify a Windows Ghidra host.
On a local Windows host, the .NET 8 ILCompiler finds the linker only through
Visual Studio 2019 or 2022 (`vswhere -version [16,18)`). With only Visual
Studio Build Tools 2026 installed, open its x64 Developer Command Prompt.
In that same `cmd.exe` session, run `set IlcUseEnvironmentalTools=true` and
then `npm run build:fixtures:nativeaot`. Running `vcvars64.bat` as a child of
PowerShell does not preserve its environment in the parent PowerShell session.

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
the legacy or native attached profile; the database-supervisor headless profile opens
a digest-verified private copy. A caller-supplied fixture keeps prerequisites
limited to the selected engine and host. `tests/conformance/ida/inventory.c`
provides an optional small native fixture source with exported
`rea_fixture_add` and `rea_fixture_subtract` functions. For their switching check,
use `--second-procedure rea_fixture_subtract --second-marker='- 13'`.

The lane invokes the production CLI dispatcher and connects the pinned MCP
client SDK to the production REA server. It verifies function Evidence and
CLI/MCP parity, inventory/search, pseudocode, instructions, xrefs, malformed
input, original-input preservation, and lifecycle cleanup. The headless
profile also checks containing procedures, the admitted program as the
document, address context, and feature tracing. For headless
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
`c133c3853faa111a9b00ee615c013b720d0c4acd` with Windows x64 IDA 9.3, and the
headless profile on macOS arm64 with IDA Professional 9.1 (build 9.1.250226)
at the same upstream commit, using `tests/conformance/ida/inventory.c` built
with `clang -O0 -arch arm64` and the procedure `_rea_fixture_add` (Mach-O C
symbols carry a leading underscore). Before the headless session waited out
the transient `busy` health a worker can report right after opening, that lane
failed intermittently on that host. Linux headless, modern attached GUI tools,
other engine versions and architectures remain unverified; see the
[provider guide](ida-provider.md).

Native IDA MCP verification uses `"protocol": "native"` with an already-running native plugin and requires `--second-procedure other_function --second-marker unique_second_body_text` to exercise GUI function switching and a return to the first function. These options remain optional for other profiles. The literal marker must appear in the second function's pseudocode and be absent from the first. Native cloud/widget failures are reported without hidden retries.

The initial Linux x64 IDA Free 9.4 run used native MCP 1.1.2 with a local navigation correction. Windows x64 verification uses **IDA Pro 9.3**, the two-function public fixture, and the shipped Windows `whoami.exe` application. The native plugin was built from upstream `c9d15d98e8a143fc74f6e14037c48f63889b6d6c`, including the merged navigation fix, with a local loopback-listener change. Production CLI/MCP parity, switching, identity and cleanup passed. Correctness and performance measurements are recorded in the [Windows native verification notes](https://github.com/morluto/rea/blob/a2e2c29b59e8775b0e6aedb09a9eb16adf32646b/experiments/analysis-efficiency/ida-native-windows.md). Stock 1.1.2 switching, native macOS, and Windows IDA Free remain unverified. See the [native bridge prerequisites](ida-provider.md#optional-native-ida-mcp-bridge).

## Kuna lane

`npm run verify:kuna` requires a caller-supplied `kuna` in `REA_KUNA_COMMAND`
and a host C compiler (`REA_CC`, default `cc`) with `strip` and `nm`. It builds a
source-owned fixture with non-inlined calls, with symbols and stripped, then verifies through MCP that
callers, callees and exact incoming xrefs agree with those calls, graph/path
composition reaches the callee, reference-only queries leave project/staging
entries unchanged, repeated relationships reuse the graph, and
the first cold pseudocode answer comes from a single-function run or an export
that already finished, assembly waits for and serves from that export, and
pseudocode and both dossier facets match their recorded file spans and digests,
a fresh server reuses the export without rebuilding it, staging is empty after
a completed export, and no owned process survives. Pass
`--targets DIR --functions a,b` to add caller-built binaries laid out as
`DIR/<flavor>/<name>` beside `<name>.stripped`; addresses come from the
symbol-bearing build. `--compare-ghidra` with `GHIDRA_INSTALL_DIR` runs those
caller-built functions through Ghidra (it refuses to run without `--targets` and
`--functions`, an empty matrix, or names missing from every supplied target) and
reports latency, sampled process-tree CPU and peak memory, UTF-8 response size,
and goto and warning-marker counts. Those counts are not a correctness judgement,
and model tokens are not measured. Reference timings and response sizes are
reported separately; reference caches expire when the server closes. `--report PATH` writes the JSON report.

The first matrix run used Kuna 1.833 and Ghidra 12.1.4 with JDK 21 on macOS
arm64. It covered zlib 1.3.2 `minigzip`, coreutils 9.9 `sort` and the sqlite
3.54.0 shell, built at `-O2` for ELF x86-64, ELF AArch64, Mach-O arm64 and
Mach-O x86-64, each with symbols and stripped. A separate Linux x86-64 run verified
the fixture and system zlib 1.2.13 / SQLite 3.40.1 libraries through MCP, including
cached byte spans and a Ghidra comparison. See the [Linux report](https://github.com/morluto/rea/pull/3854#issuecomment-6185870391)
for measured scope and limitations. Windows, PE and universal Mach-O remain
unverified by this lane.

Kuna 1.986 passed the fixture and a separate small, source-owned Mach-O with
symbols and stripped on macOS arm64, including the Ghidra comparison and owned
cleanup. Linux and other hosts have not been verified with 1.986; this check is
not a repeat of the larger 1.833 matrix.

Kuna 1.988 passed the real-provider lane on macOS arm64 with the generated
Mach-O fixture and caller-built symbol-bearing and stripped x86-64 ELF fixtures.
Linux and other hosts have not been verified with 1.988; this is not a repeat
of the larger 1.833 matrix.

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

`npm run verify:ghidra:6502` uses `ca65` and `ld65` to build the source-owned
NMOS 6502 fixture from `tests/conformance/ghidra/6502.s` and `6502.cfg`. Set
`REA_CA65` and `REA_LD65` for non-PATH installations (tested with cc65 `V2.19`).
With an installed Ghidra 12.1.4 and full JDK, it verifies real CLI/stdio MCP
mapping parity, exact source bytes, functions, a direct call reference,
decompilation, 16-bit overflow rejection without replacing the active session,
and runtime cleanup. Windows additionally requires the matching native addon;
its verifier lineage remains explicitly unavailable outside the provider's
retained Job Object, as in the other Windows lanes.

`npm run verify:ghidra:m68k` needs no assembler: its 22-byte big-endian 68000
fixture is source-owned annotated hex in the verifier, loaded at `0x1000`. With
an installed Ghidra 12.1.4 and full JDK on Linux or macOS, it verifies the
`68000:BE:32:default` BinaryLoader import, real CLI/stdio MCP load-image parity,
exact source bytes, both functions, the `bsr.b` call reference, decompilation
through address and file offset, rejection of a misaligned entry and of a mapping
past `0xffffffff` without replacing the active session, and runtime cleanup.
Windows Ghidra P0 does not admit m68k, so this is not a Windows lane. The lane
has been run on macOS; Linux has not been exercised.

`npm run verify:ghidra:raw` uses a generated ARM little-endian headerless image
through the compiled CLI and stdio MCP server. With the same Ghidra/JDK
prerequisites, it checks preparation and bridge startup, verified load mappings,
instruction and byte readback, canonical-entry session reuse, replacement when
the entry changes without `provider_id`, unchanged source bytes, and owned
cleanup. Six-byte x86 and x86_64 controls also verify supported compiler
specifications, independent mappings, unchanged bytes, and decompilation of a
known return value. AArch64 remains covered by deterministic tests rather than
this real-provider lane. See [raw binary analysis](raw-binary.md).

`npm run verify:ghidra:address-context` runs on Linux with a caller-installed
Ghidra, full JDK, and an x86-64 ELF GCC toolchain (`CC` selects another compatible
compiler). It builds
`tests/conformance/c/pie-address-context.c` as a PIE ELF without executing it.
The compiled CLI and real stdio MCP workflow must expose the measured image
base, retain segment address spaces, agree on the overview, resolve explicit and
numeric file offsets, and reject unmapped analysis addresses with actionable
guidance. It checks the reverse `address-to-file-offset` mapping, file-coordinate
Evidence locations, and the suggested CLI search and load-image commands.
The verifier compares mapped bytes with the source file and checks source
identity, session preservation after failed lookup, owned runtime cleanup, and
verified empty process lineage. This lane does not establish Windows or macOS
real-provider coverage.

For source-identity boundaries that a normal single-file import cannot create,
`tests/conformance/ghidra/ReaFileOffsetSourceProbe.java` exercises the production
bridge against real Ghidra `FileBytes`. It rejects auxiliary and partial sources,
keeps distinct outcome codes for uninitialized and unmapped addresses, checks
the original target's round trip, and retains ambiguity when duplicate target
bytes have distinct loaded mappings. Injected decompiler failures and
cancellation verify that completed source/function resolution facts and backend
failure codes survive; these injections do not establish natural engine failures.
On Windows, after creating the
source-owned PE fixture, run from the repository root:

```powershell
node scripts/create-ghidra-windows-fixture.mjs
$proofRoot = Join-Path $env:TEMP 'rea-file-offset-source-proof'
New-Item -ItemType Directory -Path $proofRoot -Force | Out-Null
Copy-Item bridge/ghidra/ReaGhidraBridge.java, bridge/ghidra/ReaGhidraExtensions.java, tests/conformance/ghidra/ReaFileOffsetSourceProbe.java -Destination $proofRoot
& "$env:GHIDRA_INSTALL_DIR/support/analyzeHeadless.bat" $proofRoot source-proof -import "$PWD/build/fixtures/rea-ghidra-windows.exe" -scriptPath $proofRoot -postScript ReaFileOffsetSourceProbe.java -deleteProject
```

Require the `REA_FILE_OFFSET_SOURCE_OK` marker and no script errors; Ghidra may
exit successfully even when a post-script fails. The probe edits only its
temporary analysis database and does not execute the fixture. This producer
regression supplements public CLI/MCP coverage and does not establish Linux
host behavior or native process-supervision controls.

## Apple Interface Builder archives

`npm run verify:interface-builder` compiles the source-owned AppKit XIB into a
real `.nib` with Xcode `ibtool`, wraps it in a temporary app bundle, and runs
the compiled CLI and stdio MCP server with production providers. It compares
their decoded results and checks the view hierarchy, outlet, action, evidence coverage, and truncation
status. It also recompiles the XIB with toggled control booleans and requires
both decodes to match `ibtool --export` for each source. Storyboard compilation
additionally requires an installed iOS platform.

Keep the provider-specific acceptance path independent from optional
cross-compilers. Cross-format failures belong to the cross-format lane and must
not make native host acceptance unavailable.

## Native platform baseline in CI

Pull requests that change only root `README*.md` files, `docs/`, `AGENTS.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `native/windows/README.md`,
or the GitHub issue and pull-request templates run formatting and
generated-document validation, including the small onboarding example consistency
suite, without the source-test shards or native package
lanes. Classification compares the PR head with its merge base, so later
base-branch changes do not expand that scope. Static and portable-test aggregate jobs
remain present and fail if classification fails. Every code change retains the
complete portable Linux suite; individual test files are not selected by
imports or filenames.

Ordinary PRs also produce an **observational** test-selection plan. The candidate
leaf-adapter ownership table lives in `scripts/ci/test-selection.mjs`, separately
from provider-job scopes. It proposes keeping affected owners plus every unowned
test, including all CLI/MCP, acceptance, composition, conformance, and process
tests. Shared inputs, unknown paths, missing owner tests, and removed tests fall
back to the complete inventory. Renames account for both paths. Main, scheduled,
manual, and `ci:full` runs always propose the full suite.

The source group and every built shard together still execute the complete suite. The existing report merge
compares the proposal with actual module outcomes and retains
`.cache/ci-test-selection/report.json` in `test-results`, including selected and
omitted paths, changed input paths, missed failures, unobserved files, scheduling weights, PR head and
executed merge SHA. This adds no test reruns or runner jobs. Missing, duplicate,
skipped, interrupted, or unhandled results cannot establish a complete comparison;
even a complete passing comparison is not proof of ownership completeness.
Before enabling omissions, review representative full-run comparisons and
cross-owner consumers, including failures, and measure completed CI feedback and
runner demand. There is no automatic promotion or switch to skip tests. The
initial proposal measures only leaf producer-test omissions; it does not promise
the savings of a broader affected-test planner.

`scripts/ci/plan.mjs` selects lanes using the ownership table in
`scripts/ci/scopes.mjs`. Each lane record owns its path and test selection
rules and required fast/full jobs; workflow contract tests verify the mapped jobs.
Provider implementation changes run their real-provider verifiers and the Linux
x64 installed-package/Inspector baseline. The `apple` scope owns the Apple artifact lane; the `package` scope owns the multi-host
package matrix and the Windows curated lane, including Windows native controls,
Inspector, setup, configuration and packaging entrypoints. Runtime sources under
`src/` or `bridge/` without an owner, and the authored skill, run the Linux suite
and the Linux x64 installed-package/Inspector baseline only. Test-only changes
run the Linux suite without native package verification, except test files that
the Apple or Windows curated lanes invoke explicitly, which also select that
lane. Packet-capture and signal-recording tests and their producers select the
corresponding real-tool lane; both also run in full qualification. The shared
Linux resource-limit source and its tests select both. Each lane requires
its Linux kernel resource-limit cases and all seven descriptor-cleanup cases to
pass in the focused Vitest report. A missing report, missing case, skipped case,
or duplicate identity fails the lane; unrelated host-specific skips remain
allowed. These tests use synthetic producers. The separate real TShark or
sigrok verifier establishes the actual-tool observation. Edits to verifier entrypoints run only by manual, licensed or self-hosted
workflows run static checks and the Linux suite. Website changes run website
checks. Provider workflow changes validate the workflow and run that provider's
verifier. Changes under `bridge/ghidra/` also select the `ghidra_bridge` lane,
which compiles the packaged bridge sources against the pinned Ghidra 12.1.4
jars with `npm run verify:ghidra:bridge-sources`. That compile step never
launches Ghidra or imports a target, so a missing import fails the PR instead
of every Ghidra session. The launcher, compiler and package checks share named required source
roles. The manifest must match the complete Java cohort, so deleting a helper
or adding an unregistered dependency cannot silently change the shipped set.
The preflight reuses the provider's Java Properties parser with the pinned Node
toolchain's native type stripping, without an npm install or runtime build.
The shared release policy owns the verified version and JDK major. CI checks
the archive pin before downloading and verifies the extracted SDK version;
changes to these source owners also select the compile lane. After compiling,
the lane launches headless Ghidra on source-owned instruction bytes with
`-noanalysis`. The ARM/Thumb probe sets each instruction's mode explicitly and
checks the bridge's decoder-context readback. The decode probes check that
`ARM:LE:32:Cortex`, `ARM:LE:32:v8-m` and `Xtensa:LE:32:default` decode their
bytes from each language's default context. The bytes are never executed, and
edits to those probe scripts also select the lane.
Manual-provider/Android workflow changes run workflow validation only.
The four-version SQLite compatibility matrix has its own `sqlite` scope for
SQLite implementation, contracts, CLI/MCP registration, fixtures, and shared
runtime boundaries. SQLite and server-lifecycle test edits and the SQLite npm
scripts also select it. Unrelated code edits retain the complete portable suite
on the pinned Node version without starting four additional compatibility jobs.
Full qualification retains every SQLite version.
Shared process/contract/CLI boundaries, dependencies, other packaging inputs,
unknown paths, and changes to the planner select the fast Linux x64 baseline:
portable code checks and the installed-package runtime lane, without provider
lanes or the multi-host package matrix. A shared file with exactly one owner
still selects that owner. Full qualification still selects every lane.
CI timing collection, timing history, and test-report helper edits retain static
checks and the complete portable suite without selecting unrelated host/provider
lanes. Classification, qualification, gate, release receipt, and unknown CI
scripts keep that fast baseline.
Package script-only edits select their owning verifier when its entrypoint is
identifiable; unknown or shared script changes select the fast baseline. Android
build-script edits retain the Linux suite and workflow validation; real Android
verification stays manual. Renames account for both paths.

The `agentenv` scope owns the environment application and server modules, the
`environment-serve` and `environment-export` command registration, the shared
streamable HTTP listener, `scripts/verify-agentenv-environment.mjs` and its
workflow `real-agentenv.yml`. The lane exports a bundle from the source-owned
Grafana-shaped capture through the built CLI, packs the checkout into the
bundle's image and runs `agent-env run` on the hosted runner's Docker with the
pinned `agentenv-framework` release; it passes when the smoke task passes and
no container remains. It claims nothing about any hosted platform or another
framework version.

This narrower selection trades PR-time coverage for runner capacity. A change to
unowned shared runtime code that fails only on arm64, macOS, Windows, the Apple
artifact lane, or a provider lane that does not own the file is not caught on
the PR; scheduled full qualification reports it after merge. Ownership globs do
not follow imports. Use the `ci:full` label when a change may have native-host
or provider effects outside its owners.

Ordinary main pushes use the same owner scopes as PRs. Their diff starts at a
successful ancestor push run of this CI workflow, rather than the preceding
push: changes from failed or cancelled intermediate runs remain in scope.
Missing, untrusted, or non-ancestor history selects the fast Linux x64
baseline: portable checks and the Linux runtime lane. The lookup is
bounded to the last 100 successful push runs; lookup failures broaden selection.
Every code change still selects the source group and all eight fast built shards, without coverage
instrumentation in this fast tier. Ordinary PR matrices cancel remaining
shards after the first failure; passing PRs execute the complete suite. Main,
`ci:full`, scheduled, manual, and release qualification retain every shard's
results after a failure. Available failed-shard reports remain diagnostic only:
failed, cancelled, skipped, or missing selected shards cannot pass the gate or
publish successful timing history. This deliberately avoids relying on an
import graph for generated files, filesystem inputs, subprocesses, or bridges.
The portable report rejects an entirely skipped module inventory and lists
fully skipped modules in its summary. A mixed passed/skipped inventory is
allowed: Vitest's skip state does not establish whether a skipped module was
required on that runner. Review the listed skips against platform and provider
prerequisites; the inventory alone does not prove every required case ran.

Scheduled qualification is admitted hourly at minute 23. A forced full run at
03:23 UTC refreshes runner and dependency drift every day. Other hourly runs
can reuse a successful full-qualification receipt for the exact source SHA
from the same repository's trusted CI workflow on its default branch. Both the
receipt and original workflow run must be less than 24 hours old, so retrying an
old gate cannot renew stale proof. Missing, expired, failed, foreign, or uncertain proof runs full
validation; API lookup failure also runs full. Lookups examine at most 100 named
receipts and three candidate runs within a 20-second budget. Reused runs select
no validation lanes, identify the original run, and produce no new receipt, so
reuse cannot indefinitely extend proof freshness. They make no fresh provider
observation. Manual dispatch, `ci:full`, and exact release qualification always
run full validation.

Full qualification includes aggregate coverage,
every portable provider lane, and all native hosts below. Adding `ci:full`
immediately starts the separate `Full PR qualification` workflow against the
label event's merge revision; subsequent PR revisions also select the full tier
in normal CI while that label remains. Unrelated labels do not start validation
jobs or replace the main CI checks. Manual dispatch also requests full validation.
Fast-tier broad fallbacks keep the portable suite and the Linux x64 runtime
baseline. They do not start every owner lane or the three-host package
matrix. Intel macOS and coverage remain full-tier obligations. Real provider
lanes stay path-gated, and a shared registration file listed by many lanes
does not start those lanes on a fast PR. Each
classification job records its selection and broad-fallback reasons in the run
summary. Representative Git-diff cases live in
`tests/boundary/filesystem/ciChangeScope.test.ts`.

`CI required` checks classification and every selected lane,
rejecting failed, cancelled, or unexpectedly skipped work. It rejects missing or
unknown tiers and requires every canonical scope to be explicitly `true` or
`false`; incomplete classification cannot silently omit verification lanes.
The aggregate remains cancellable so superseded runs release their slots.
Branch protection
should require this aggregate, `Static checks`, `Portable tests`, and
`Conventional PR title`. Title validation runs separately on PR opening,
reopening, commits, and edits; correcting a title refreshes only this lightweight
check. It reads title text through an environment variable, executes no PR code,
and has no token permissions. Its separate concurrency group cannot cancel
test runs. Fast PR runs cancel superseded feedback for the same PR. Main push
runs keep one active run and the latest pending run for that branch.
Scheduled/manual qualification has a separate concurrency group: active work
finishes and only the latest pending run is retained. Release qualification uses
its exact source SHA and cannot be cancelled by newer main pushes. Provider and
website lanes inherit their caller's scheduling; reusable
workflows have no independent cancellation group. Direct manual lane dispatches
run independently on disposable hosted runners. Publication
requires that qualification to succeed and consumes its exact verified tarball,
checking source SHA, workflow run, run attempt, package/Node version and SHA-256
before npm publication. Earlier attempts from the same workflow run are accepted
when rerunning failed publisher jobs; future attempts and other runs are rejected.
The public-registry canary still verifies the published package. Licensed/self-hosted
provider workflows and the Android smoke test retain their explicit triggers.

CI exercises the pinned Node.js runtime on native hosted runners:

| Host                  | Runner             | Baseline checks                                                                             |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| Linux x64             | `ubuntu-latest`    | Installed package and real Node Inspector CLI/MCP                                           |
| Linux arm64 (aarch64) | `ubuntu-24.04-arm` | Installed package and real Node Inspector CLI/MCP                                           |
| macOS 15 arm64        | `macos-15`         | Installed package and real Node Inspector CLI/MCP                                           |
| macOS 15 x64          | `macos-15-intel`   | Installed package and real Node Inspector CLI/MCP (hourly, dispatch, release and `ci:full`) |
| Windows x64           | `windows-latest`   | Curated capabilities, native controls, installed package and real Node Inspector CLI/MCP    |

macOS x64 is the slowest package host. Ordinary PRs and main pushes omit it,
so darwin x64 installed-package and Inspector regressions surface in full
qualification. Schedule admission can be delayed by GitHub; the hourly trigger
does not guarantee an hourly completed result. Release publication waits for
its own complete result at the exact released revision.

Package lanes assert the actual Node platform/architecture before verification
and record those values with the Node version. The package matrix runs up to
four jobs concurrently on independent hosted runners with explicit
timeouts and per-runner Node heap/thread limits; Windows retains its curated
capability lane. Package checks cover installation, CLI/MCP discovery,
target-free analysis, configuration backups/recovery, Evidence and owned
lifecycle; Inspector checks execute source-owned loopback targets and special
filename cases.

POSIX package verification resolves the runner's configured npm cache before
creating disposable client homes and passes that location to its child installs.
This reuses the download cache restored by the shared npm-cache action while keeping client
configuration isolated. Installs retain their existing registry and integrity
checks.

The Apple artifact CLI/MCP lane uses one `macos-15` job to avoid adding demand
for scarce macOS runner capacity. It runs the artifact-format and metadata
verifiers, followed by one consolidated focused invocation containing all
existing native and process-boundary regression paths.
The real native provenance verifier checks CLI/MCP agreement on complete
per-slice encryption absence. The encryption CLI regression builds a universal
image, marks its owned arm64 command with `cryptid=1`, and compares the reported
range with `otool`; this verifies declared metadata, not actual FairPlay data.

The Linux source-test shards download a shared runtime and generated test
metadata snapshot produced by the build job with `npm run test:prepare`. The
snapshot includes `dist/`, generated skills, the MCP tool catalog, product
catalog, and managed-conformance metadata. Each shard still installs the locked
dependencies and runs its assigned tests; full qualification enables coverage. It no longer
regenerates the same metadata independently.

The build job finds the newest trusted timing artifact for its tier
(`test-timings-fast` or `test-timings-full`) from a successful default-branch
push, schedule, or manual CI run, and includes that same report in each shard's
snapshot. The bounded lookup verifies the producer. Pull-request runs and other
branches are not producers. A tier with no qualifying artifact leaves history
unset, and Vitest uses its own assignment. A later schedule that reuses
qualification without uploading timings leaves the previous artifact in place.

On 2026-10-21 the newest full history was run
`39545047294`, recorded before compiled-CLI session reuse. Fast run
`39552964873` packed its eight built shards from that history, and those shard
jobs executed for 319–591 seconds. Replaying that run's file durations through
the sequencer's two-worker schedule balances every shard at about 404 seconds
of file time. The same replay with the stale history weights leaves the slowest
shard near 547 seconds and the fastest near 293. That spread is file-schedule
time, not runner queue, which is why each tier keeps its own history.
CI assigns discovered files by historical duration, with a deterministic
fallback weight for new files, rather than dividing only by file count.
Each file keeps its full duration on one worker. Extra workers overlap other
files in the same sequence group, and `process-boundary` runs after that
group. History published before the competing-loader split still names only
`javascriptLiteralPercentPaths.test.ts`. Until an artifact records
`javascriptLiteralLoaderOwnership.test.ts`, the sequencer assigns that
recorded duration by the pre-split case counts: 54/192 stays with the
percent-path file and 138/192 goes to the consolidated loader file. History
that names the retired Early, Middle, and Late shards sums those durations
onto the consolidated file instead, and scales a partial set as three equal
shares. That weight is the old dual-surface cost. The demoted file runs every
loader once through the shared stdio MCP session, so the first schedule
overestimates it. Every discovered file still belongs to exactly one shard;
worker limits and project ordering remain unchanged. Fast qualification keeps
eight built shards without coverage. The merge job rejects successful reports
with missing, unexpected, or duplicate portable files. Coverage instrumentation
and aggregate thresholds remain enforced in full qualification.
Missing or unusable history falls back to Vitest's default assignment. Only
timing data is reused; live provider results are never cached. Turbo outputs are
restored by task hash, with trusted default-branch runs as cache writers and PRs
as restore-only consumers. The static job also restores its Turbo snapshot;
each task revalidates its own input hash before reusing outputs or diagnostics.
The Node pin and npm install settings are global hash inputs. Knip runs only
in full qualification, with `--cache` and a GitHub cache of
`node_modules/.cache/knip`. The saved key includes the commit SHA. Restore uses
the configuration prefix, so the next trusted full run can publish a refreshed
snapshot. That cache is an AST cache keyed by file mtime and size, so a
fresh checkout often misses it; Turbo still hashes the Knip task inputs. Knip
includes its ignore rules and VitePress
entry, so changes to those inputs cannot reuse an older successful check.
Jobs that run Turbo export `TURBO_TEAM`. A called workflow sees the caller
event, so `workflow_call` is not an event name inside CI. `TURBO_TOKEN` is set
when release qualification passes `remote_cache_write`, or when the ref is the
default branch and the event is push, schedule, or workflow_dispatch, and only
when that secret is available to the run. Release qualification passes
`TURBO_TOKEN` and `remote_cache_write` into the called workflow. Labeled
pull-request qualification does not. Pull requests receive an empty token and
`TURBO_CACHE=local:rw`. Remote reads require `TURBO_TOKEN`, and this repository
does not pass a separate read-only credential into pull requests. An empty
token leaves the local Turbo cache in place.

The shared npm-cache action caches downloads, not `node_modules`, and every
consumer still runs `npm ci`. Keys cover the runner OS, actual Node architecture,
root lockfiles, and `.npmrc`. An exact-key miss restores the newest cache for
that OS and architecture, so a lockfile change reuses unchanged tarballs while
`npm ci` still verifies the lockfile. Only push, schedule, and manual events on
the repository's default branch may save shared npm caches, and only from the
opted-in writer for that host: Static checks for Linux x64, the package matrix
for every other included host, and the Windows curated lane. Every other job
restores without saving, so parallel jobs do not publish duplicate copies.
Pull requests restore only. Static snapshots are saved only after the static
job's validation succeeds. Cache deletion is a
separate workflow, because reusable qualification calls this workflow and
cannot raise its read-only token. After a push, schedule, or manual CI run on
the default branch finishes, including when a later lane fails, times out, or
is cancelled, that workflow runs on `ubuntu-latest` and deletes older
`rea-static-v1`, `rea-static-deep-v1`, and `rea-portable-build-v2` entries for
that runner's OS and architecture, plus older `knip-meta-v1` entries for that
OS. It keeps two generations plus the key that run saved. A fast run that did
not publish a deep or Knip snapshot still leaves the two newest entries in
those families. It
deletes an npm download record only when another record has the same key, cache
version, and git ref, and it keeps the most recently accessed copy. A different
version or ref is a different restore target and stays. One cache id is one
record: a repeated id keeps the later access time when its key, version, ref,
size, and creation time agree, and an inconsistent repeat deletes nothing. An
incomplete or unexpected cache list deletes nothing.
Distinct lockfile generations of the download cache stay, so the restore
prefix still has a seed.
Main warms the new cache namespace after merge; a cold cache falls back to the
normal install. This prevents each PR from saving another branch-scoped copy of
the same download cache. It does not remove runner assignment waits.

Portable owner-based test selection remains observational. Its reports compare
proposed omissions with the full run; incomplete or skipped observations do not
establish that fewer tests would preserve regression detection.

The automatic browser, binary-layout, EVM, JavaScript-recovery, packet-capture,
signal-recording, recorded-crash, web and environment-bundle provider lanes download
`rea-build-cache` from their own run after the build and static jobs succeed. Their existing build commands still
validate task hashes and rebuild mismatched inputs; provider observations always
run. Provider-workflow-only edits also admit the build without enabling source
test shards. Direct provider dispatches retain the cross-run restore-only cache.
This removes repeated compilation on fresh source revisions, but adds the build
as a prerequisite: a delayed build can delay provider admission. Compare queue
and execution times before claiming an end-to-end speedup.

These native baseline checks complement the Linux source-test shards and the
separate Apple-artifact and real-provider lanes. Actual Hopper, Ghidra, IDA,
browser and managed-tool claims require their corresponding verification lanes.
Runner labels follow the [GitHub hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

### Termux Android browser smoke test

The **Real Termux browser verification** workflow is manual-only while its
emulator setup is being validated. After the workflow reaches the default
branch, select a revision under **Actions → Real Termux browser verification →
Run workflow**. It boots an Android 11 (API 30) x86_64 emulator, installs the
checksum-verified Termux 0.118.3 APK, and lets the app initialize its bootstrap.
The host stages the selected revision using `git archive HEAD`; no workstation
build outputs or dependencies are copied into Android.

`scripts/verify/termux/emulator.sh` sends a `RUN_COMMAND` intent to Termux's app
service. Root access is limited to staging files, sending the intent, and reading
diagnostics; installation, compilation, Node, and Chromium run as Termux's app
UID. The in-app script installs Termux's Android-linked Node distribution,
checks its version against `.nvmrc`, pins npm from `packageManager`, runs
`npm ci`, and builds with `build:termux`. Termux repository packages, including
Chromium, are resolved at run time; their installed versions are logged.

The verifier leaves Playwright's cache environment overrides unset, requires
a healthy public MCP doctor result, and captures URL plus DOM from a loopback
HTTP fixture through `capture-browser-scenario`. It checks completed steps,
the exact URL, a DOM marker, and reported browser cleanup. This lane covers one
Android emulator and Termux combination, not physical ARM devices, Electron,
or the complete desktop browser suite. A workflow definition alone does not
establish passing Android coverage; inspect its execution receipt.

The `termux-browser-diagnostics` artifact retains the Termux command log, exit
status, and Android logcat on success or failure. The emulator is disposable.

## Packet capture analysis

`npm run verify:pcap -- --pcap PATH` exercises caller-supplied tshark and
capinfos against a saved capture. Linux verification uses Wireshark 4.6.6
and captures containing DNS, TLS and HTTP traffic. Native Windows and macOS
engine behavior remains unverified; process fixtures do not establish it.
See [Packet capture analysis](pcap-analysis.md) for contracts and budgets.

## Apple native metadata and UI

`tests/boundary/mcp/nativeDispatchBoundTarget.test.ts` uses the production
stdio MCP server on macOS to bind an inert, self-authored Mach-O, then replace
its path with missing, directory and symlink-loop states. Each refusal must
report `artifact_changed`; restoring the same bytes must succeed in the same
session. A separate non-root case checks real read permission denial as
`access_denied`. These tests read the target without executing it. Controlled
provider tests retain the physical acquisition failure through descriptor close
denial and confirm cleanup retry releases the original owner.

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
  process and helper. These lanes require an interactive macOS desktop. See [native investigation](native-investigation.md).

`npm run verify:native-calls` needs macOS with Command Line Tools (`clang`,
`lldb`, `codesign`, `nm`) and actual debugger access to the owned fixtures.
The lane reports Developer Mode status without treating it as proof of access
or denial, and does not change host settings. LLDB and target entitlements
establish the tested permission boundary.
It compiles `tests/conformance/native/calls.m` and
runs `observe-native-calls` through the CLI and stdio MCP. It checks:

- the receiver class, selector and argument registers of every entry, and that
  breakpoint addresses equal `nm`'s symbol addresses;
- overlapping breakpoint selections retain each selection's hits and share
  the aggregate event limit; callback capture reads the stopped frame before
  LLDB resumes, avoiding stale frame metadata from asynchronous stop events;
- captured stdout and an environment override, plus a 2 MiB flood on each
  output stream with bounded retained prefixes and exact drained-byte counts;
- the event-limit and duration outcomes, with the process confirmed gone;
- that a hardened-runtime copy is refused with `debugger-attach-denied`, and
  that the same copy signed with `get-task-allow` is traced.

### Firmware adapters

Linux-owned provider launches require a procps-compatible `ps` on REA's `PATH`
so ownership can be inspected before launching a child. A missing or incompatible
command fails with an actionable capability error before the launch.

`npm run fixtures:firmware` uses existing Python 3 and a host C compiler to make
an ignored gzip/USTAR firmware fixture and independent offset/hash oracle.
`npm run verify:firmware` requires caller-supplied Binwalk 3.1.0, Unblob 26.6.4
and util-linux prlimit on Linux, with `7z` on `PATH` for the gzip/USTAR
fixture's Unblob extractor. The provider also accepts other 3.1.x and
26.6.x builds and reports them as unverified; this lane proves the audited
releases. It verifies CLI/MCP parity, selected ranges,
unknown chunks, depth limits and extracted child digests. The optional
`REA_FIRMWARE_VERIFY_EXT4=1` lane requires existing mke2fs/debugfs; the separate
`REA_FIRMWARE_VERIFY_GHIDRA=1` lane checks a selected host ELF through real Ghidra.
Neither optional toolchain is a base-lane prerequisite. See
[firmware analysis](firmware-analysis.md) for limits and unverified formats.

`npm run verify:esp-images` requires a Clang with the RISC-V target and
`ld.lld` (`REA_RISCV_CLANG`, `REA_RISCV_LLD`) and a Python that runs esptool
and espsecure (`REA_ESPTOOL_PYTHON`). It builds ESP32-C3 app and bootloader
ELF files from `tests/conformance/esp/`, converts them with `esptool
elf2image`, including `--secure-pad-v2`, `--ram-only-header` and
`--pad-to-size`, signs one with RSA, ECDSA P-256 and P-384 keys, and compares
REA's facts with `esptool image-info` and `espsecure signature-info-v2`. It
compares extracted segments and signature blocks with the producer's bytes,
and derives malformed images and ESP8266 v1 and v3 images. It checks each
tool before building and warns when esptool is not the pinned v5.6.0.
`REA_XTENSA_ESP32_GCC` adds an ESP32 Xtensa build. See
[ESP images](esp-image.md).

`npm run verify:uf2` needs only a Python that runs esptool, named by
`REA_ESPTOOL_PYTHON` (default `python3`). It writes inputs at known addresses,
builds UF2 files with esptool's `merge-bin --format uf2` (v4 `merge_bin`) with
and without MD5 and with 256-byte payloads, and concatenates two chips'
outputs. Inspection and extraction through the built CLI must return each input
at its address under the familyID esptool itself reports. It is not part of CI.
See [UF2 and DfuSe images](uf2-dfuse.md).
`npm run verify:esp-flash` needs the same tools and an ESP-IDF checkout
(`REA_ESP_IDF_PATH`) for `gen_esp32part.py` and `otatool.py`. It builds
partition tables, assembles dumps with `esptool merge-bin`, writes OTA records
with otatool through `tests/conformance/esp/flash_file_tool.py`, and compares
REA's flash facts with `image-info`, the decoded table and
`otatool read_otadata`. See [ESP flash images](esp-flash-image.md).

### JavaScript source recovery

Build once with `npm run build:cached`, then run `npm run verify:javascript:recovery`.
This focused lane requires Linux x64, util-linux `prlimit`,
`REA_WAKARU_COMMAND` pointing to the official Wakaru 1.14.0 Linux x64 binary,
and `REA_JAVASCRIPT_FIXTURE_TOOLS` pointing to an isolated npm prefix containing
esbuild 0.25.10 and webpack 5.101.3. No global installation is required.
The lane compiles source-owned fixtures, exercises CLI and stdio MCP, verifies
published bytes and provenance, feeds recovered modules into existing analysis,
and compares a finite set of known fixture results. A webpack fixture with separate
runtime, shared, entry and lazy chunks verifies multi-input recovery through both
surfaces, per-file provenance and resolved cross-chunk imports in the downstream
application graph. The provider also accepts
other ^1.13.0 releases and reports them as unverified; this lane proves the
audited release. It does not establish
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
Run `npm run verify:javascript:output -- jsonl` for compact JSONL coverage. Its
row collection must match independent row and final-metadata byte/digest goldens;
its token count is checked against the actual file one line at a time, even when
the complete export exceeds the engine string limit. This opt-in lane is separate from routine tests and the canonical hash check
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

`npm run verify:binary:layout` requires Linux x64, GCC/binutils, the
`i686-linux-gnu`, `arm-linux-gnueabi`, `mips-linux-gnu` and `mipsel-linux-gnu`
cross `gcc`/`readelf` toolchains, absolute
`REA_PWNTOOLS_PYTHON` with pwntools 4.15.0/pyelftools 0.33/Unicorn 2.1.2 and
absolute `REA_VERIFY_STRACE_COMMAND`. It compiles ephemeral source-owned ELF
fixtures and checks public CLI/MCP, lossless addresses/names, file ranges,
mitigation inferences, malformed/unsupported input, original file hashes and
released process ownership. Cross-compiled ELF32 executables and relocatable
objects check the reported class, machine and byte order, and every section
name, address, offset and size against GNU `readelf`. Exec syscall tracing must identify only the declared
Node/Python launchers; no target binary is executed. Core/debugger claims need
separate verification lanes. Pass an installed package entrypoint as the script's
first argument to verify packaging independently of the checkout.
The valid SHN_XINDEX fixture has 65,281 full section rows; CLI is checked in
the ordinary lane. Its large MCP transfer is opt-in with
`REA_VERIFY_LARGE_ELF_MCP=1` (or the workflow dispatch `large_mcp` input), an
explicit 256 MiB SDK receive buffer, matching server `REA_MCP_MAX_RESPONSE_BYTES`,
and five-minute request timeout. Ordinary
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

### Exported environment bundles

`npm run verify:agentenv:environment` is the `real-agentenv` lane. It requires
the host's Docker CLI named by absolute `REA_DOCKER_COMMAND`, Python 3.12 with
`agentenv-framework==0.9.1334` installed in a virtual environment whose
`agent-env` binary is named by absolute `REA_AGENT_ENV_COMMAND`, and outbound
network for `pip` on the runner and for `npm` inside the image build. Both
variables are required; neither upstream executable is resolved from `PATH`,
and the verifier installs nothing. Packing uses the shared npm helper, honoring
`npm_execpath` from the caller's selected npm. Direct Node invocations without
that value use the helper's platform fallback, so configure the pinned toolchain
on `PATH` for those runs. It checks the supplied runner's `--version` against the pin before
using Docker and retains the observed version in both passing and failing receipts.
Its disposable CI runner creates the virtual environment in runner
storage, exports both paths and uses the runner's own Docker; no developer host
configuration changes. `agent-env run` attempts share one 22-minute budget
inside the 30-minute job (the first attempt at most 15 minutes), so a hung or
retried run ends with the verifier's failed receipt rather than the runner's
kill. The framework builds its gateway and service-db
images from `public.ecr.aws` on every fresh runner, and hosted runners share
that registry's anonymous pull quota, so the lane first pulls the base images
the pinned framework's Dockerfiles name from `mirror.gcr.io`, which serves the
same Docker official images under the same digests, and names them as those
Dockerfiles do (on Docker's containerd image store, so digest-pinned names
resolve), as the framework's own CI does. The quota handling below covers
anything still pulled from that registry. The receipt's `agent_env_run` records the
last run whether it passed or failed, with `public_ecr_quota` set to
`data_limit` or `rate` when that registry's `429 Too Many Requests` ended it.
The data-transfer cap (`toomanyrequests: Data limit exceeded`) is counted per
source IP, so it fails the lane at once: a pause on the same runner cannot lift
it. When a rate refusal ends the run and at least five minutes of the budget
would remain after the pause, the verifier waits 90 seconds and runs once more,
recording `attempts: 2` and `retried_for` in the receipt. Any other failure
ends the lane at once.

The verifier writes the Grafana-shaped HAR the view tests own, packs the
checkout with `npm pack`, builds the bundle from the HAR with
`rea environment-build --package-tarball` through the built CLI, the command
users run, so the image installs this checkout rather than the registry
package, and runs `agent-env run` on the bundle. It checks that the build
reports the 28-record capture, the default template rules, the planned file set
with the shipped manifest naming the reported capture, a coverage summary whose
read and served write tools add up to the served tool count, and a bundle
served from the derived state, which serves fewer tools than the
manifest because write tools the capture did not confirm are not served, that the runner exits `0` with
`tasks/smoke.json` reported as passed and the verifier's description naming
that served tool count, and that no container exists
after the run that did not exist before; the container inventory runs even when
the run fails or times out, so a failed receipt still lists what it left. The one exception is the framework's
own image-store helper, `agentenv-registry` (or `agentenv-registry-<port>`),
a `registry:2` container the local provider starts on first use and keeps
running across runs; a first run on a fresh host creates it, so the receipt
lists it under `image_store_helpers` instead of counting it as a leak. Images
built by the run remain and are counted in the receipt. Pass an installed
package entrypoint as the script's first argument for package coverage.

## Agent evaluation and conformance records

`npm run verify:agent` evaluates investigation scenarios through a real local
Codex CLI. The lane runs sequentially; select scenarios with
`REA_AGENT_EVAL_SCENARIOS` and choose the installed client/model with
`REA_CODEX_CLI` and `REA_AGENT_EVAL_MODEL`. The detailed
[agent evaluation reference](client-verification.md#agent-evaluation-and-conformance-records)
contains isolation, authentication cleanup, grading, and conformance boundaries.

The Notes evaluation packages `website/public/examples/notes-electron/`. When
changing those example bytes, run `tests/boundary/mcp/agentKnownAnswerMcp.test.ts`
and check its rubric in `tests/evaluation/model-evals/AgentEvaluationFixtures.ts`.
Preserve exact source facts and the coverage reported by the analysis. If a
source change crosses an unresolved static-analysis boundary, keep that
uncertainty and a negative control rejecting claims of complete coverage.

## Frida instrumentation

`npm run verify:frida` builds REA, spawns a short-lived local Node.js fixture,
loads a harmless marker script before resuming it, captures the message, and
detaches. This lane requires Linux on the REA host and the optional Frida
binding; it does not need a Frida server or a caller-selected process. To run
the separate remote attach lane, pass `-- --address HOST:PORT --pid PID` for an
explicitly selected process. Optional remote flags are `--token`,
`--certificate`, `--origin`, and `--keepalive-interval` (seconds); authentication values
are not written to files or included in the report. Mock tests do not establish
real device/server compatibility.

### Offline WASM artifacts

`npm run verify:wasm:artifact -- --require-tools` uses an absolute
`REA_WABT_BIN_DIRECTORY` containing WABT 1.0.42, including `wat2wasm` for fixture
generation. It installs nothing. Without configuration, the default invocation
reports a named skip; `--require-tools` makes missing configuration fail.

The verifier creates and validates real modules with custom sections, multiple
import/export kinds, escaped names, an empty module, and a bulk-memory
DataCount section. Debug-name fixtures cover compiler-generated module names
and preserved name-section payloads with empty, multiline, Unicode, long and
NUL-containing names. It compares exact WAT,
section output and selected/tool digests through the compiled CLI and real MCP
SDK, validates advertised schemas, checks identical CLI/MCP Evidence IDs and
session bundle readback, retains invalid/truncated module diagnostics, preserves
all inputs and checks workspace cleanup.
The lane also injects one cleanup denial for exact private runtime roots and
input descriptors, checks recovered CLI errors, and verifies retry on the same
MCP connection after repeated runtime-removal denial. These are controlled
faults, not naturally occurring permission failures; no WASM target is executed.
Pass an installed package's
`scripts/rea.mjs` as the first argument to run the same lane against the package.
`npm run verify:wasm:package` packs and installs REA into an isolated temporary
prefix with lifecycle scripts disabled and runs the same required real-tool lane.
It requires WABT configuration and makes no host tool installation.

Source-owned provider tests separately exercise cancellation, deadline propagation,
malformed producer output and cleanup uncertainty; shared owned-command tests
exercise actual subprocess timeout and cancellation.
