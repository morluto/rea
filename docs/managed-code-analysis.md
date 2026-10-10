# Managed-code analysis

REA inspects .NET PE/CLI artifacts without loading or executing their code.
It can identify an assembly, inspect metadata and CIL, compare members across
builds, and connect declared native calls to supplied native-analysis evidence.
CIL is Common Intermediate Language, the instruction format used by managed
assemblies.

The seven shipped tools are:

| Task                                                                        | MCP tool                            |
| --------------------------------------------------------------------------- | ----------------------------------- |
| Identify an artifact and its managed deployment form                        | `inspect_managed_artifact`          |
| Inspect types, signatures, method bodies, calls, and field access           | `inspect_managed_members`           |
| List declared native calls and native implementation indicators             | `inspect_managed_native_boundaries` |
| Compare members across builds and map build-local tokens                    | `compare_managed_members`           |
| Check native call declarations against supplied export or function evidence | `verify_managed_native_boundaries`  |
| Import decompiled code against verified static member identities            | `import_managed_reconstruction`     |
| Add managed findings to an application graph                                | `project_managed_application_graph` |

Each has a matching CLI command: replace underscores with hyphens and prefix
the name with `rea`, for example `rea inspect-managed-artifact`.
Native-body bridge mapping and managed runtime execution are outside the
current tool set.

The canonical tool inventory is the
[build-generated catalog](mcp-contracts.md#generated-catalog).

## Shipped scope

The canonical parser admits PE/CLI bytes and their metadata/CIL without loading
an assembly. It reports observed implementation markers and unavailable facts;
it does not unpack .NET single-file hosts, decode IL2CPP metadata, or infer a
NativeAOT identity from an ordinary native PE. Inputs without admitted CLI
metadata do not become managed assemblies through naming or routing guesses.
Inspect separately obtained components explicitly and preserve their identities.

A valid implementation marker establishes a candidate native boundary, not
recovered native semantics or runtime behavior.

## Analysis objective

REA's managed-code track is intended to answer five different questions without
collapsing them:

1. What exact artifact and managed deployment form is this?
2. What do its admitted metadata and CIL bytes state?
3. What source-like or behavioral structure can be reconstructed or inferred?
4. Which findings survive an exact-build check or a cross-build structural
   comparison?
5. Which remaining questions require native analysis or runtime evidence that
   static inspection cannot supply?

The ordinary workflow ends at question four. Static analysis never loads or
executes the target.

## NativeAOT metadata recovery

NativeAOT removes the ordinary CIL method bodies, so a CIL decompiler cannot
reconstruct those bodies as C# source. The executable remains a native target
for Hopper or Ghidra, where decompilation produces pseudocode and analyst
inference. This is a different route from ordinary managed member inspection.

NativeAOT is not limited to Windows `.exe` files. The native image can be PE,
ELF, or Mach-O, and NativeAOT can also publish shared libraries (PE DLL, ELF
`.so`, or Mach-O `.dylib`) with explicitly exported entry points. Identify the
image from its bytes and loader metadata, not its filename extension. When the
image is inside an application bundle, inventory or extract the bundle first
and carry the component identity into native analysis. Matching PDB, ELF debug,
or dSYM sidecars can add symbol evidence when the selected provider supports
them; verify their identity and keep them separate from observations made from
the executable itself. [Microsoft's NativeAOT overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
lists supported OS/architecture targets and deployment limitations, while its
[native library guide](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/libraries)
describes exported shared-library entry points.

REA supports an optional headless adapter for the Ghidra NativeAOT analyzer.
Supply a locally built `REA_GHIDRA_NATIVEAOT_JAR`; REA does not install the
extension or its toolchain. The verified boundary is .NET 8.0.22 RTR 9.1,
x86-64 ELF and native Windows PE targets analyzed on Linux x64 with Ghidra
12.1.4 and JDK 21. Other layouts, architectures, and hosts are unsupported.
See [NativeAOT recovery](ghidra-nativeaot.md) for build/configuration, recovered
metadata, derived-memory provenance, and the real verification lane.

REA's experimental Windows Ghidra boundary admits native x86 and x86-64 PE
applications and DLLs for static analysis. This does not establish Windows
NativeAOT metadata-recovery coverage.

For NativeAOT analysis, preserve the selected native artifact's path and digest
and report recovered type data as provider observations. Linking those types
to native function addresses requires verified
provider evidence; names or vtable similarity alone do not prove that a native
function implements a specific managed method.

## Evidence record shape

Member comparison, application graph projection, and managed/native verification
authenticate supplied inspection Evidence and check that any subject SHA-256
matches the normalized artifact SHA-256. A valid Evidence ID alone does not
establish that those two identities agree. Evidence without a subject remains
usable, with no subject digest available to cross-check.

Artifact inspection returns the selected path, byte length and SHA-256, observed
PE/CLI classification, assembly and module identities, and metadata coverage.
Member inspection binds build-local tokens, signatures, row offsets, method
bodies, and decoded relationships to that artifact and MVID. Missing or malformed
facts remain explicit in coverage and per-member status.

CLI `#GUID` heap values retain their exact 16-byte GUID text. REA does not impose
RFC 4122 UUID version or variant bits on MVID, EncId, or EncBaseId because
ECMA-335 metadata does not require those bit patterns. Tokens and RVAs are
build-local coordinates, not durable cross-build identities or native addresses.

## Decoded-CIL fingerprint

`inspect_managed_members` exposes two method CIL hashes with different byte
boundaries:

| Field                  | Input                                                                                                     | Excluded from the digest                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `il_sha256`            | The exact `il_size` raw CIL bytes after the tiny or fat method header                                     | Method header, locals signature blob, alignment, and extra sections including exception clauses                                                               |
| `normalized_il_sha256` | UTF-8 `JSON.stringify` output for the instruction-order array of `[opcode, operand_kind, operand]` tuples | Instruction offsets except projected scalar branch targets, switch targets, resolved metadata/string identities, method header, locals, and exception regions |

The normalized field is available only when the entire CIL stream decodes with
status `present`. A malformed or absent body reports `null`. The tuple format
is defined here.

Tuple operands use these exact projections:

- operand-free instructions: `none` and `null`;
- metadata and user-string operands: the build-local token as lowercase
  `0x`-prefixed eight-digit hexadecimal;
- scalar branches: the target CIL byte offset as a decimal string;
- `switch`: the case count as a decimal string, without target offsets;
- signed integer and variable operands: decimal strings; floating-point
  operands: JavaScript's `String` representation of the decoded IEEE value.

Opcode names retain short/long forms and prefix opcodes. This makes the value a
reproducible decoded-tuple fingerprint, not a canonical semantic CIL identity:
it does not resolve tokens across MVIDs, does not commit full control flow or
exception semantics, and does not replace the raw CIL digest. Cross-build
comparison uses the value only as one unique-only structural tier and reports
ambiguity when that evidence is insufficient.

For example, a decoded `nop; ret` body serializes exactly as
`[["nop","none",null],["ret","none",null]]` and has digest
`5e5fad7741cb44bca3a4f045546b7449990da343f612f5f34c0ca30e9eee0636`.
This vector specifies the tuple order, `null` handling, absence of whitespace,
UTF-8 encoding, and lowercase hexadecimal output.

## Member comparison

Names and semantic labels do not establish durable member identity. Comparison
preserves observed differences, structural inferences, and unknowns separately.

Cross-version matching first prefers exact CIL/signature identity. When that
does not match, it pairs an exact declared type, method name, and raw signature
before trying structural body shape. The exact-signature key uses names only
as part of that full tuple; names alone never select a pair. Duplicate tuples
remain ambiguous rather than being paired by token order. Fields follow the
same exact tiers. The raw signature is exact whether or not REA decoded it, so
undecoded signatures pair by that tuple too, but they never enter structural
rounds. An unmatched member is therefore reported as `unknown`, not added or
removed, when its own signature was not decoded or when the other side has an
unpaired member, one-sided or ambiguous, with the same declared type and name
whose signature was not decoded.

For a matched method, an unavailable or partial body makes body-shape facets
unknown while preserving observed signature differences. Structural identity
compares normalized signatures, the limited decoded-CIL tuple fingerprint,
constants, and bounded shape context. It reports all candidates at the winning
score and remains ambiguous when the evidence does not distinguish them. The
digest does not itself remap metadata tokens.

Tokens are always remapped through observed structure. A caller cannot carry
`0x06001234` into a new MVID and assume it names the same method.

## Managed/native boundary rules

`verify_managed_native_boundaries` compares declared P/Invoke module and entry
point identities with supplied native export or function evidence. Name/module
matches establish declaration links; they do not establish that a call executed.

Metadata tokens are not native addresses. Native body mapping for C++/CLI,
ReadyToRun, NativeAOT, and IL2CPP requires separately verified format and provider
support. The managed static tools do not recover those mappings. The optional
[Ghidra NativeAOT extension](ghidra-nativeaot.md) has its own supported boundary.

Declared import inventory supports a bounded positive claim. Its absence does
not exclude dynamic resolution, generated code, protected code, native helpers,
or server-side behavior.

## Tool and packaging boundary

The production parser is REA-owned TypeScript and ships with the existing Node
application. Deterministic conformance uses source-owned byte-built PE/CLI
fixtures and expected semantic facts. An optional real ILSpy lane runs only when
its executable is explicitly supplied; the default lane does not establish
independent pinned-oracle parity. Production inspection needs none of those tools.

- `ICSharpCode.Decompiler`/`ilspycmd` can supply reconstruction inference.
  A BYO reconstruction import records the supplied version
  and remains non-canonical. When `REA_ILSPY_CMD_PATH` points to an absolute
  runnable `ilspycmd`, `verify:managed` runs a source-owned real ILSpy oracle
  and imports its C# output as reconstruction inference against exact static
  member Evidence.
- The package contains no .NET runtime, SDK, ILSpy installation, proprietary
  assembly, or compiled conformance fixture.
- Setup never installs or upgrades those tools. Doctor may inspect an explicit
  optional path without changing it.

Real-tool downloads used in development or CI require exact package coordinates
and SHA-256 lock entries. They are cached outside the source tree and restored
into isolated directories. Updating any coordinate requires review of license,
runtime, supported host, output contract, and conformance results.

Target platform is not host support. The canonical parser must inspect
Windows-produced PE/CLI bytes on REA's supported Linux and macOS hosts with the
same result. Pinned Windows oracle jobs may provide additional conformance, but
they do not claim that the REA application itself supports Windows. Native
ReadyToRun, C++/CLI, NativeAOT, or IL2CPP coverage is additionally constrained
by the selected Hopper/Ghidra host and format matrix.

## Conformance verification

The current lane uses source-owned byte-built fixtures and malformed-input
regressions, with optional operator-supplied applications and ILSpy verification.

Run the deterministic lane with `npm run verify:managed`. See
[testing](testing.md#real-toolchain-verification-lanes) for prerequisites and
coverage. Generated outputs belong outside tracked fixture directories and must
not remain after verification or packaging.

Verification compares semantic facts, not decompiler text. It checks resource
ceilings, deterministic ordering, complete cleanup, CLI/MCP parity, Evidence
commitments, packed-package behavior, and target-free MCP startup. A parser and
an oracle disagreeing on malformed input is investigated explicitly; one tool's
acceptance does not automatically make the bytes valid.

## Operator-local osu! benchmark

The optional osu! benchmark accepts only paths and expectations supplied by the
operator. Run it with:

```sh
REA_MANAGED_APP_MANIFEST_PATH=/absolute/managed-app-manifest.json npm run verify:managed
```

`verify:managed` always runs a source-owned manifest-verifier self-test first.
If `REA_ILSPY_CMD_PATH` is set to an absolute `ilspycmd` path, it also runs a
source-owned ILSpy oracle: version discovery, class listing, bounded C# output
for a pinned fixture type, and import through `import_managed_reconstruction`.
The verifier prints only command/version, executable and output digests,
Evidence IDs, method locks, and compact fixture identity; it does not print
decompiled C# text. A failing ILSpy oracle fails the verifier because it is an
explicit real-tool claim, but leaving `REA_ILSPY_CMD_PATH` unset keeps the
oracle disabled.

When `REA_MANAGED_APP_MANIFEST_PATH` is set, the manifest's target path may be
absolute or relative to the manifest file. A compact manifest contains:

```json
{
  "label": "operator-local osu!stable semantic slice",
  "target": {
    "path": "./osu!.exe",
    "sha256": "<exact target digest>",
    "mvid": "<exact module MVID>",
    "assembly_name": "<expected simple name>",
    "runtime_family": "dotnet-framework",
    "managed_architecture": "x86"
  },
  "methods": [
    {
      "label": "operator-local semantic label",
      "token": "0x06000000",
      "signature_sha256": "<raw signature blob digest>",
      "il_size": 0,
      "il_sha256": "<raw CIL byte digest>",
      "normalized_il_sha256": "<digest>"
    }
  ],
  "application_graph": {
    "expected_node_kinds": [
      "artifact",
      "managed-assembly",
      "managed-module",
      "managed-type",
      "managed-method"
    ],
    "feature_traces": [
      {
        "label": "operator-local feature label",
        "method_token": "0x06000000",
        "seed": "<method name, API name, string, or digest to trace>",
        "match": "exact",
        "case_sensitive": true,
        "min_matched_seeds": 1
      }
    ]
  }
}
```

Before evaluating methods, the verifier fails closed on target SHA-256, MVID,
assembly name, runtime-family, and managed-architecture mismatches whenever the
manifest supplies those fields. It then pages each declared MethodDef token
directly by row, so selected methods do not need to appear in the first member
page of a large application. Optional `il_sha256` locks the exact raw CIL bytes
in addition to REA's decoded-instruction-tuple digest. That normalized field
has the byte boundaries documented above and is not a complete semantic CIL
identity.

The optional `application_graph` block reuses those exact-build method
commitments. For each referenced MethodDef token, the verifier builds a bounded
managed application-graph projection from the authenticated artifact and the
single selected member page, then checks requested node kinds and feature-trace
seed matches. This proves only that the selected static facts enter REA's graph
and tracing vocabulary for that exact local build; it does not execute the
application, inspect arbitrary unlisted methods, or infer runtime behavior.

Output contains assertion status and compact identities only: file name,
target SHA-256, MVID, assembly name, runtime-family, managed architecture,
method tokens, method names, signature digests, IL sizes, normalized IL
digests, graph Evidence IDs, node-kind summaries, and trace seed hit counts. It
does not print method bodies, reconstructed C#, application data, runtime
telemetry, account/service details, full filesystem inventories, or the
target's absolute path. The manifest and target remain outside git.

The benchmark may prove that REA reproduces selected facts for that exact local
build. It cannot establish general support on its own; source-built conformance
remains the admission requirement.

## Runtime behavior boundary

Managed inspection does not execute assemblies or observe CLR internals.
Questions about actual behavior remain unknown until supported runtime
evidence is collected. A direct process capture can retain declared inputs,
outputs, filesystem and protocol activity for a target run; it does not prove
which managed methods executed or how the CLR resolved them.

## Method metadata during build comparison

Managed member comparisons report a `metadata` dimension when an observed
MethodDef flags or implementation flags value differs, including accessibility
or synchronization changes. This is separate from the CIL/signature matching
tiers: identical instructions do not establish unchanged method metadata. The
reported difference is static metadata evidence, not proof of runtime behavior.
