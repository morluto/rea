# Optional NativeAOT metadata recovery

REA integrates [Washi1337/ghidra-nativeaot](https://github.com/Washi1337/ghidra-nativeaot)
through an optional headless adapter. The original source is an opt-in submodule,
pinned to `effeb734fc570c32650f88b159608979dc7b423e`; its MIT license and existing
source notices are retained. No upstream source or algorithms are rewritten.

The initial tested layout is .NET runtime **8.0.22**, NativeAOT RTR **9.1**,
x86-64 ELF and native Windows PE **targets analyzed on Linux x64**, using
Ghidra **12.1.4** and JDK **21**. Other layouts/architectures/hosts are unsupported.
Windows Ghidra P0 has no database mutation authority. A PE/CLI or ReadyToRun
assembly should use `inspect_managed_artifact`; it is not NativeAOT.

## Build and configure

Bring your own supported Ghidra/JDK installation. This developer build needs
existing `git`, `javac` and `jar`; it does not invoke Gradle, download toolchains,
or change host configuration:

```sh
git submodule update --init third_party/ghidra-nativeaot
npm run build:ghidra:nativeaot
export REA_GHIDRA_NATIVEAOT_JAR="$PWD/_reference/nativeaot-integration/extension/rea-ghidra-nativeaot.jar"
```

The build requires a clean pinned upstream checkout, compiles unchanged upstream
Java plus the REA facade, uses a fresh classes directory, and writes the JAR and
build manifest under ignored `_reference/`. `REA_NATIVEAOT_BUILD_ROOT` can select
another local output directory; `REA_NATIVEAOT_SOURCE` can select an equivalent
clean pinned source checkout. Neither output nor compiled fixture belongs in Git
or the npm package. An installed REA accepts an existing explicitly supplied JAR.

REA commits the actual JAR SHA-256 into the analysis profile, copies identical
bytes into the owned runtime, rechecks the digest before loading, and closes the
classloader/project on session close. Profiles cannot enable code absent from
explicit local configuration. JARs execute within Ghidra; supply a build you trust.
The producer's reported source revision is build metadata, not an attestation of
arbitrary caller-supplied bytes. The bounded loader accepts regular JARs up to
8 MiB to limit startup artifact memory; this does not truncate analysis results.

## Use existing tools

Open the executable with provider `ghidra`. `inspect_native_load_image` returns
optional `observations.metadata_recovery` inline, including the detected header,
layout, recovery status, type category paths/addresses, diagnostics, annotation
coverage and derived-memory SHA. The enclosing `unsupported` load-image status
for PE/ELF concerns independent DOS loader verification; metadata recovery has
its own status. It is not a failed import.

Pass one returned type path or its typed address to `inspect_native_data_type`.
Its optional `metadata_recovery` includes related/base type, implemented
interfaces and virtual slots with targets and known procedure names. Follow
these with `analyze_function`, string searches and ordinary cross-references.
For CLI use:

```sh
rea inspect-native-load-image ./NativeAotFixture --provider ghidra --json
rea inspect-native-data-type ./NativeAotFixture --type /NativeAOT/MethodTables/Class_ADDRESS_MT --provider ghidra --json
rea function ./NativeAotFixture 0xADDRESS --provider ghidra --json
```

No new MCP workflow or approval flag is required. Configuration opts into the
adapter; without it ordinary Ghidra profiles/results remain unchanged.

## Evidence boundaries

Discovery prefers an imported RTR symbol, otherwise the upstream initialized,
non-executable-memory signature heuristic. REA rejects ambiguous candidates,
unknown layout versions, malformed directory rows, unsupported flags and
unmapped ranges before recovery. It requires the verified dehydrated layout.

The adapter performs rehydration, method-table recovery and frozen-object
annotation in one ephemeral Program transaction. Fatal failure/cancellation
rolls it back. Recovery may change analysis-memory bytes, never the original
executable file. Derived ranges have a digest and **no original file offset**;
they are not captured runtime state. Candidate/committed instance annotation
counts distinguish partial frozen-object coverage. Coverage concerns the
recovered candidate set, not every possible object or every runtime type.

REA preserves pre-recovery calling conventions and uses the loaded compiler
specification default for newly created methods. The upstream universal
`__thiscall` assignment is not treated as x64 ABI authority. Parameters and
method prototypes remain inferences; verify them against instructions/call sites.

Type relationships and System.Object/System.String identification use upstream
heuristics. Generated names are explicitly marked; original class/member names
and custom field layouts remain unknown. Pseudocode is recovered native logic,
not original C# source. Unsupported recovery reports its stage and reason; it
does not imply that ordinary native disassembly/decompilation is impossible.

## Verification

See [the dedicated lane](testing.md#optional-nativeaot-ghidra-analysis).
Fixtures are source-built benign .NET programs with inheritance, an interface,
virtual dispatch, representative arithmetic and frozen strings. Independent
compiler/linker symbols and raw directory bytes provide the oracle. Stripped
fixtures exercise heuristic detection. Tests do not execute the resulting
NativeAOT binaries. Fixture generation and adapter compilation are optional and
never prerequisites of ordinary native analysis or setup.
