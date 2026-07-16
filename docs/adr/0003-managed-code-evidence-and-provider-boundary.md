# ADR-0003: Managed-code evidence and provider boundary

- Status: Accepted
- Date: 2026-07-16
- Implementation status: Read-only PE/CLI triage and exact identity are shipped
  through `inspect_managed_artifact` / `rea inspect-managed-artifact`. Bounded
  metadata, signatures, method bodies, normalized CIL, exception regions, call
  edges, and field-access anchors are shipped through `inspect_managed_members`
  / `rea inspect-managed-members`. Decompiled C#, cross-build matching, and
  managed/native composition remain future contracts.

## Context

Professional C# reverse engineering is not one decompiler operation. A file
described as “.NET” can be ordinary Common Intermediate Language (CIL),
ReadyToRun code containing both CIL and native implementations, a single-file
deployment, C++/CLI mixed mode, Unity Mono, Unity IL2CPP, or NativeAOT. Those
forms have different sources of truth and different native-analysis needs.
Choosing a decompiler before classifying the artifact can therefore produce a
plausible but false model.

The durable static facts in an ordinary managed PE are its PE/CLI headers,
metadata tables, signatures, method bodies, exception regions, and CIL. A C#
decompiler reconstructs source-like control flow and language constructs from
those facts. That reconstruction is valuable, but it is not the original
source and cannot replace the underlying metadata and CIL evidence. Obfuscation
makes names especially weak while tokens remain coordinates in only one build.

REA already separates one selected deep native provider from disjoint auxiliary
providers under [ADR-0001](0001-provider-selection-and-analysis-profiles.md).
It also separates static evidence, passive observation, process capture, and
controlled replay authorities. Managed analysis must fit those boundaries
without requiring a CLR to inspect an artifact, loading target code into the
REA process, or treating a managed token as a native address.

The design is informed by exact-build, reflection-free metadata extraction,
hash-locked method manifests, independent behavior models, and managed/native
boundary analysis performed against a local C# application. The application,
its decompiler output, and its runtime observations are research inputs only;
they are not distributable REA fixtures.

## Decision drivers

1. Classify the deployment before selecting an analysis route.
2. Make metadata and CIL independently inspectable without a CLR or target
   execution.
3. Preserve exact-build provenance while enabling structural comparison across
   builds whose MVIDs, tokens, names, and layout differ.
4. Compose managed and native analysis without introducing another ambiguous
   deep-provider candidate.
5. Keep decompiled C# useful but epistemically subordinate to canonical bytes.
6. Analyze Linux, macOS, and Windows managed artifacts through the same local
   CLI/MCP contracts on REA's supported hosts.
7. Keep setup additive and prevent managed analysis from installing .NET,
   ILSpy, an SDK, or another unrelated toolchain.
8. Prove semantics with source-built conformance artifacts and compact,
   operator-local real-application checks.

## Terminology

- **Managed artifact**: a PE, bundle component, or related metadata artifact
  that carries a CLI header, CLI metadata, CIL, or another managed-runtime
  commitment.
- **Classification vector**: independently observed container, runtime family,
  implementation form, and architecture. It is not one guessed label.
- **Canonical static observation**: a bounded value decoded directly from the
  target bytes under a versioned parser contract.
- **Reconstruction**: source-like output, including decompiled C#, derived from
  canonical observations.
- **Structural inference**: a relationship or cross-version match derived from
  signatures, APIs, constants, control/data-flow shape, or other observations.
- **Validation**: an independently checked proposition, for example a
  source-built oracle assertion or a behavior-model corpus result.
- **Runtime observation**: a separately authorized fact obtained by attaching,
  loading, debugging, instrumenting, or otherwise executing code.

## Decision

### 1. Classify before analyzing

Managed triage returns a classification vector and the observations supporting
each dimension. Absence of a marker produces `unknown` or `not_applicable`, not
an invented runtime family.

| Dimension           | Initial values                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Container           | PE file, single-file bundle, bundle component, Unity metadata pair, native image, malformed, unknown         |
| Runtime family      | .NET Framework, modern .NET, Unity Mono, Unity IL2CPP, NativeAOT, mixed CLR/native, unknown                  |
| Implementation form | CIL, CIL plus ReadyToRun, native only, C++/CLI mixed, metadata only, unsupported, unknown                    |
| Architecture        | PE machine plus CLI flags; component-specific architecture for bundles; conflicting or unknown when required |

Target-framework attributes, assembly references, metadata stream versions,
bundle manifests, ReadyToRun directories, and native headers are observations.
They may support a runtime-family inference, but no single string is treated as
authoritative when the other bytes conflict.

Classification selects these routes:

| Observed form                     | Managed route                                                                  | Native route and limitation                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Ordinary Framework or modern CIL  | Full metadata, signatures, method bodies, and CIL                              | Optional only for declared interop boundaries                                                              |
| Obfuscated CIL                    | Same canonical route; names receive no special trust                           | Optional for declared interop boundaries                                                                   |
| Unity Mono assembly               | Same canonical route with Unity context retained                               | Optional for engine/native boundaries                                                                      |
| ReadyToRun                        | Metadata/CIL where present; implementation availability is per method          | Selected Hopper/Ghidra analyzes native sections; CIL absence is reported per method                        |
| C++/CLI mixed mode                | Metadata/CIL for managed members and explicit mixed-mode boundary observations | Selected Hopper/Ghidra analyzes native bodies; REA never converts tokens directly to native addresses      |
| Single-file deployment            | Inventory the bundle, then analyze each authenticated managed component        | Selected Hopper/Ghidra analyzes the host/native components; unsupported compression remains explicit       |
| Unity IL2CPP                      | Pair and authenticate available Unity metadata; do not claim canonical CIL     | Selected Hopper/Ghidra analyzes the generated native binary; semantic recovery is degraded until supported |
| NativeAOT                         | Report any independently present managed metadata, otherwise no CIL claim      | Treat as a native target with NativeAOT provenance; managed source reconstruction is unavailable           |
| Malformed or unsupported artifact | Return bounded partial observations and typed unavailable/unknown scopes       | Do not silently retry by loading or executing the file                                                     |

Classification is byte-driven and bounded. File extensions, product names,
process names, and an operator's description are hints only.

### 2. Implement managed static analysis as a disjoint auxiliary provider

The initial producer is a REA-owned auxiliary provider with ID
`rea-dotnet-static`. It owns a disjoint managed-artifact operation family. It is
not registered as a Hopper/Ghidra deep-provider candidate because it does not
compete for the same operation names and must be able to coexist with the one
selected native provider.

```text
                      one opened artifact/session
                                  |
                    SessionProviderRouter
                      /                       \
        rea-dotnet-static auxiliary       selected deep binding
        PE/CLI metadata and CIL            Hopper or Ghidra
                      \                       /
                       explicit managed/native links
                                  |
                         Evidence and workflows
```

An ordinary managed artifact can therefore remain unbound to a deep native
provider while managed operations work. ReadyToRun, C++/CLI, IL2CPP, NativeAOT,
and interop workflows may additionally require a caller-selected native
binding. Native-provider failure never causes managed evidence to be relabeled,
and managed-parser failure never causes an implicit native fallback.

Provider mechanics live under a provider directory such as `src/dotnet/`.
Provider-neutral identities, evidence states, and bounded values may live in
the domain/contracts layers. Application code composes results but does not
parse PE headers, metadata tables, signatures, CIL, ReadyToRun headers, or
provider-specific output.

### 3. Make the production static path byte-only and execution-free

`rea-dotnet-static` reads approved local bytes and implements the required
PE/CLI metadata and CIL subset in TypeScript. It does not call any reflection
API and does not require the .NET runtime. In particular, static inspection
must never:

- call `Assembly.Load`, `Assembly.LoadFrom`, `ReflectionOnlyLoad`, or an
  equivalent runtime loader;
- resolve target dependencies by executing target-controlled resolver code;
- run module initializers, constructors, entry points, build tasks, plugins, or
  generated helpers;
- start the target, attach to a process, contact a service, or inherit target
  configuration and credentials; or
- interpret a decompiler, CLR, or native-provider diagnostic as an observation
  from the artifact bytes.

The parser uses checked offsets and additions, explicit endianness, bounded
table/heap/body counts, cycle-safe traversal, and typed partial results. A bad
row, signature, body, resource, or stream does not authorize an unbounded retry
or a CLR load. Complete-coverage claims require every applicable bounded region
to have been admitted; otherwise coverage is partial, unknown, or unavailable
with exact offsets and reasons.

The input path remains under REA's approved investigation roots. Local artifact
paths, digests, MVIDs, tokens, malformed offsets, and analysis metadata are
actionable diagnostics and are not secrets. Credentials, authorization data,
and genuine secrets remain redacted.

### 4. Bind every finding to exact artifact and producer identity

Every managed result carries a commitment with at least:

```text
artifact: canonical path + byte length + SHA-256
component: container identity + component path/name + component SHA-256, when applicable
classification: container + runtime family + implementation form + architecture
assembly/module: simple name + version + culture + public-key identity + module name + MVID
producer: provider ID + exact version + parser/profile schema + profile digest
```

An assembly-qualified name does not replace the artifact digest or MVID.
Neither an MVID nor an Authenticode signature proves who authored the behavior.
Bundle components retain both their container and component commitments so that
bytes extracted from another host cannot be silently substituted.

Method observations add:

```text
declaring type + normalized CLI signature
build-local metadata token
RVA/file extent when present
exact method-body SHA-256
normalized-CIL schema version + SHA-256 when CIL is valid
max stack + locals signature + exception-region commitment
```

The exact body hash commits header bytes, CIL bytes, and admitted extra
sections. Normalized CIL decodes instructions, converts branch operands to
instruction coordinates, and resolves metadata operands to canonical
signatures or literal identities under a versioned algorithm. It preserves
opcode, prefix, constant, local/argument, generic, and exception semantics. It
does not erase differences merely to make two builds match.

Metadata tokens are reported because they are precise coordinates inside one
module. Cross-version identity never consists of a token alone. A structural
match cites both build commitments, both local tokens, the normalized inputs,
the matching algorithm version, and all competing candidates.

### 5. Separate five evidence layers

Managed workflows retain these layers independently:

| Layer                  | Examples                                                              | Permitted claim                                                 |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Static observation     | Metadata row, signature, CIL opcode, literal, exception region        | “These bounded bytes decode to this value.”                     |
| Reconstruction         | Decompiled C#, async/iterator source shape, expression simplification | “This is one source-like representation of cited observations.” |
| Structural inference   | Likely caller, field flow, behavior slice, cross-build method match   | “These cited structures support this relationship.”             |
| Independent validation | Synthetic oracle, corpus result, second parser agreement              | “This declared proposition passed the named independent check.” |
| Runtime observation    | Exact-build attach/load/instrumentation event                         | “This separately authorized experiment observed this event.”    |

Each layer has its own producer, authority, state, confidence, coverage, and
limitations. A readable C# method is never emitted as original source or exact
semantic proof. A validator does not upgrade unrelated claims. Runtime
agreement does not retroactively turn a static inference into an observation.

Negative results are scope-qualified. For example, “no declared P/Invoke rows
were found in the admitted metadata tables” does not prove the application has
no native, dynamically resolved, generated, server-side, or protected path.

### 6. Admit ILSpy only as an optional reconstruction and conformance tool

REA's canonical static operations do not depend on ILSpy, a .NET SDK/runtime,
dnlib, or Mono.Cecil. The following review was current on the decision date:

| Tool                         | Reviewed coordinate | License | Runtime/host observation                                                    | Decision                                                                                         |
| ---------------------------- | ------------------- | ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `System.Reflection.Metadata` | 10.0.10             | MIT     | Library targets .NET Framework 4.6.2, .NET 8/9/10, and .NET Standard 2.0    | Pinned independent metadata oracle for conformance; not shipped or invoked by production parsing |
| `ICSharpCode.Decompiler`     | 10.1.1.8388         | MIT     | Library targets .NET Standard 2.0; output is reconstruction                 | Pinned reconstruction/differential oracle candidate                                              |
| `ilspycmd`                   | 9.1.0.7988          | MIT     | Cross-platform .NET 8 tool; newer 10.1.1.8388 requires .NET 10              | Initial optional BYO reconstruction coordinate because it matches the source research baseline   |
| dnlib                        | 4.5.0               | MIT     | Cross-platform library; also exposes assembly-writing APIs                  | Differential test candidate only; its writable model is outside the production trust boundary    |
| Mono.Cecil                   | 0.11.6              | MIT     | Cross-platform .NET Framework/.NET Standard library with read/write support | Differential test candidate only; not a production dependency                                    |

Coordinates and package hashes used by real verification are checked into a
source-owned lock manifest when that verifier is implemented. “Latest” is
never a reproducibility coordinate. A version change requires conformance and
an explicit profile/version change.

Artifact platform and REA host support are separate. The byte-only parser must
inspect PE/CLI artifacts produced for Windows on a supported Linux or macOS REA
host; that is not a claim that REA itself currently runs on Windows. Managed
library/tool candidates above are cross-platform at their reviewed targets, but
native composition remains limited by the selected Hopper/Ghidra host and
format support. Real verification runs the canonical path on Linux and macOS
and may run pinned oracle checks on Windows without turning that development
check into a public Windows-host claim.

If a caller-visible C# reconstruction operation is admitted, it is a distinct
optional capability. It accepts only an exact supported BYO `ilspycmd`, records
the tool and decompiler version, runs in an owned bounded process without
loading target code into REA, and links output to the canonical method
observation. Setup and installers do not download or install ILSpy, .NET, an
SDK, or a runtime. Doctor may inspect an explicitly configured executable and
report exact actionable incompatibility. Missing reconstruction never removes
canonical metadata/CIL capabilities.

This decision does not make a decompiler process a security sandbox. The
initial public path can defer C# reconstruction while canonical contracts and
process isolation are proven.

### 7. Use source-built conformance and operator-local real targets

The repository stores source, build descriptions, expected semantic facts,
and tool lock manifests, but not compiled managed binaries. An isolated build
step creates fixtures outside source directories and records their SHA-256 and
MVID before verification. At minimum, the corpus covers:

- Framework-compatible and modern .NET metadata;
- AnyCPU, x86, and x64 PE/CLI flags;
- generics, nested types, overloaded signatures, properties, events, resources,
  attributes, and constants;
- exceptions, filters, prefixes, switch branches, P/Invoke, async and iterator
  state machines;
- obfuscated and Unicode names without assigning semantics from names;
- malformed headers, tables, heaps, signatures, bodies, and exception regions;
  and
- two semantically related builds with different MVIDs, tokens, layout, and
  selected names.

Expected facts are checked directly and against pinned
`System.Reflection.Metadata`; ILSpy, dnlib, or Mono.Cecil may add differential
coverage but do not vote by majority. Disagreement is a failing or explicitly
unsupported case, not silently normalized output.

The real-application benchmark is an operator-local, opt-in osu! check derived
from the research workflow. It accepts an explicit path plus a compact
expectation manifest; verifies target SHA-256, MVID, architecture, and expected
assembly identity before analysis; and emits only bounded identities, tokens,
signatures, IL lengths/hashes, match states, and assertion results. It does not
emit full IL, decompiled source, runtime logs, user data, credentials, or
service/account material. No proprietary binary, hash-locked application
manifest, or derived dump is committed to REA.

### 8. Keep runtime correlation a different, default-disabled authority

Static managed support grants no permission to attach, load, debug, reflect,
instrument, invoke, or execute. A future runtime capability must distinguish
those effects, remain disabled by default, require explicit administrator and
per-call approval, and bind to the exact artifact SHA-256, MVID, method
signature, and CIL/body shape observed by the static path.

Runtime admission must additionally validate host OS, CLR family, architecture,
and supported build/tool versions; bound time, threads, outputs, UI and network
effects; avoid real services and accounts; and own all created processes and
artifacts through complete cleanup. Reflection-only loading is still a CLR load
and is not a substitute for the static byte parser.

Runtime implementation is intentionally outside the initial static PRs and
requires its own threat model and admission decision.

## Public contract consequences

- Managed static operations will have CLI and MCP parity and produce the same
  Evidence commitments.
- Adding managed operations changes the caller-visible tool inventory and
  generated product catalog only in the implementation PR that admits them.
- Partial parsing includes admitted/dropped counts, exact limitations, and
  coverage; it never returns a partial list labeled complete.
- Managed addresses distinguish file offsets, RVAs, native virtual addresses,
  metadata tokens, and CIL offsets. They are not interchangeable.
- Cache compatibility is exact on artifact/component commitment, parser
  profile, normalized-CIL schema, and producer version.
- Provider-neutral workflows may compose canonical managed findings with the
  one native binding, but every source operation retains its actual producer.

## Alternatives rejected

### Make ILSpy the only managed provider

This would make canonical metadata/IL inventory depend on a separately
installed CLR and conflate source reconstruction with byte observations. It
would also make tool-version drift part of ordinary inventory. ILSpy remains a
valuable optional reconstruction and conformance tool instead.

### Use `Assembly.Load` or reflection-only loading

Both delegate parsing and dependency behavior to a CLR and make static support
runtime-dependent. Ordinary loading can execute target code; reflection-only
loading still establishes a CLR load boundary and is unavailable across modern
runtimes in a uniform way. Neither is required to decode ECMA-335 bytes.

### Register the managed analyzer as another deep candidate

That would force callers to choose managed analysis instead of Hopper/Ghidra
for ReadyToRun and mixed-mode artifacts even though both are needed. Disjoint
auxiliary composition represents the real ownership boundary.

### Treat tokens, names, or decompiler output as durable identity

Tokens and obfuscated names change across builds, while decompiler output
changes across tools and versions. They remain useful build-local coordinates
or reconstruction labels but are insufficient for exact or structural
cross-version identity.

### Package a .NET runtime or mutable managed library in REA

This would expand installer effects, package size, patching obligations, and
the target-parsing attack surface. The initial byte parser keeps canonical
support within REA's existing Node runtime; external managed tools remain BYO
or development-only oracles.

## Rollout gates

1. Add read-only triage and identity with malformed-input bounds. Shipped.
2. Add metadata, signatures, method bodies, normalized CIL, and exact Evidence. Shipped.
3. Add obfuscation-resistant slices and cross-build match states.
4. Compose explicit managed/native boundaries with Hopper/Ghidra.
5. Add source-built, pinned real-tool, package, CLI, and MCP conformance.
6. Consider separately authorized runtime correlation only after the static
   foundation and its authority model are stable.

Every gate must keep unsupported ReadyToRun, NativeAOT, IL2CPP, mixed-mode, or
bundle cases explicit rather than broadening claims to make a fixture pass.

## References

- [ECMA-335: Common Language Infrastructure](https://ecma-international.org/publications-and-standards/standards/ecma-335/)
- [.NET ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run)
- [.NET Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [.NET single-file deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)
- [`System.Reflection.Metadata` package](https://www.nuget.org/packages/System.Reflection.Metadata/10.0.10)
- [ILSpy repository and releases](https://github.com/icsharpcode/ILSpy)
- [dnlib repository](https://github.com/0xd4d/dnlib)
- [Mono.Cecil repository](https://github.com/jbevain/cecil)
