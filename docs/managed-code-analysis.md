# Managed-code analysis plan

This document turns
[ADR-0003](adr/0003-managed-code-evidence-and-provider-boundary.md) into an
implementation and verification plan. REA currently ships read-only PE/CLI
triage and exact identity through `inspect_managed_artifact` and
`rea inspect-managed-artifact`, plus bounded metadata, signature, method-body
CIL, exception-region, call-edge, and field-access inspection through
`inspect_managed_members` and `rea inspect-managed-members`, and
declared ModuleRef/ImplMap/PInvoke and native implementation boundary inventory
through `inspect_managed_native_boundaries` and
`rea inspect-managed-native-boundaries`, plus obfuscation-resistant member
comparison through `compare_managed_members` and `rea compare-managed-members`,
managed/native export or function Evidence matching through
`verify_managed_native_boundaries` and `rea verify-managed-native-boundaries`,
decompiler reconstruction import through `import_managed_reconstruction` and
`rea import-managed-reconstruction`, and default-disabled runtime-correlation
admission planning through `plan_managed_runtime_correlation` and
`rea plan-managed-runtime-correlation`, plus static managed graph projection
through `project_managed_application_graph` and
`rea project-managed-application-graph`. Native-body bridge mapping and runtime
execution remain planned behavior. The current product inventory remains the
one in [`product-catalog.json`](product-catalog.json).

## Analysis objective

REA's managed-code track is intended to answer five different questions without
collapsing them:

1. What exact artifact and managed deployment form is this?
2. What do its admitted metadata and CIL bytes state?
3. What source-like or behavioral structure can be reconstructed or inferred?
4. Which findings survive an exact-build check or a cross-build structural
   comparison?
5. Which remaining questions require native analysis or a separately
   authorized runtime experiment?

The ordinary workflow ends at question four. Static analysis never loads or
executes the target.

## Classification workflow

Classification proceeds from the outermost authenticated bytes inward:

```text
source path
  -> canonical path, size, SHA-256
  -> container inventory
  -> PE/native header and architecture
  -> CLI header and metadata root
  -> deployment/runtime markers
  -> per-component and per-method implementation availability
  -> managed-only, native-only, composed, degraded, or unsupported route
```

The result is a vector rather than one label. For example, a single-file modern
.NET deployment can contain a native host, ordinary CIL assemblies, and
ReadyToRun components. Each component receives its own digest, classification,
coverage, and route while retaining the outer bundle commitment.

| Case                  | Required positive observations                                               | Claims that remain unavailable or inferred                                                |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| .NET Framework        | Valid CLI metadata plus bounded Framework-specific target/reference evidence | Exact installed CLR and runtime behavior                                                  |
| Modern .NET           | Valid CLI metadata plus bounded target/reference/runtime-config evidence     | Exact runtime selected on another host                                                    |
| Unity Mono            | Valid managed assembly plus authenticated Unity context when supplied        | Engine behavior or native integration not represented by metadata                         |
| ReadyToRun            | Valid managed metadata plus authenticated ReadyToRun header/sections         | Native implementation semantics until a selected deep provider analyzes them              |
| C++/CLI               | Valid CLI metadata plus mixed-mode PE/header evidence                        | Mapping managed declarations to native implementations without explicit bridge evidence   |
| Single-file           | Valid authenticated bundle inventory and component extents                   | Components that are compressed or encoded by an unsupported bundle version                |
| Unity IL2CPP          | Authenticated native image/metadata pairing and supported metadata version   | Canonical CIL and source-equivalent C#                                                    |
| NativeAOT             | Native image plus bounded NativeAOT evidence                                 | Ordinary CLI metadata/CIL unless independently present                                    |
| Obfuscated assembly   | Same positive byte observations as its underlying deployment form            | Meaning inferred only from names                                                          |
| Malformed/unsupported | Exact admitted regions and failure locations                                 | Completeness, successfully skipped rows, or semantics beyond the admitted parser boundary |

## Evidence record shape

Every planned operation returns a provider result and Evidence with four
commitment groups:

### Artifact commitment

- canonical local path, byte length, and SHA-256;
- outer-container identity and digest when inspecting a component;
- component name/path, byte extent, and SHA-256;
- observed PE machine, CLI flags, and conflicts;
- classification vector, supporting observations, and unresolved dimensions.

### Module commitment

- assembly simple name, version, culture, public-key/token state, flags, and
  hash algorithm;
- module name, generation, and MVID;
- target framework and runtime/version strings with their exact metadata
  locations;
- parser/provider version, profile schema, limits, and profile digest.

CLI `#GUID` heap values are committed as their exact 16-byte GUID text. REA
does not impose RFC 4122 UUID version or variant bits on MVID, EncId, or
EncBaseId because ECMA-335 metadata does not require those bit patterns.

### Entity commitment

- table kind and build-local token;
- declaring scope and normalized CLI signature;
- row/heap/body locations expressed as typed file offsets, RVAs, or CIL
  offsets;
- exact raw bytes or bounded value digest;
- method body, normalized CIL, locals, exception-region, and generic-context
  commitments where applicable.

### Epistemic commitment

- authority: static bytes, reconstruction, structural inference, independent
  validation, native provider, or separately authorized runtime;
- state: observed, inferred, unknown, or unavailable;
- confidence independent of authority;
- coverage and admitted/dropped counts;
- exact supporting Evidence IDs and actionable limitations.

A semantic label such as `score_submission_gate` can annotate an entity, but it
is never the entity's identity. The same applies to an obfuscated name, token,
RVA, or decompiler-generated local name.

## Planned static capabilities

The caller-visible grouping and exact tool names are decided with the contracts
that implement them. The underlying capability slices are:

1. **Triage and inventory**: container/component classification, assembly and
   module identity, references, files, exported types, resources, attributes,
   and runtime markers.
2. **Member inventory**: bounded types, methods, fields, properties, events,
   interfaces, nesting, generics, and normalized signatures.
3. **Method inspection**: headers, max stack, locals, CIL instructions,
   constants, metadata operands, exception regions, and implementation flags.
4. **Relationships**: declared overrides, interface implementations, member
   references, direct CIL callers/callees, field access, construction, and
   interop declarations. Dynamic dispatch remains qualified.
5. **Structural search and comparison**: signature/API/constant/flow anchors,
   exact and normalized hashes, competing candidates, and explicit
   exact/structural/missing/ambiguous states.
6. **Managed/native composition**: P/Invoke, unmanaged exports, COM/mixed-mode
   declarations, ReadyToRun/native bodies, single-file hosts, and authenticated
   IL2CPP pairs linked to selected Hopper/Ghidra evidence. The shipped
   verification workflow checks P/Invoke declarations against supplied native
   export or function Evidence; native-body, thunk, and token-to-address bridge
   mapping remain unavailable without explicit provider-supported evidence.
7. **Application graph projection**: managed assembly/module/type/method/field,
   P/Invoke, and native-implementation declarations enter the same
   Evidence-backed application graph vocabulary as JavaScript/Electron
   findings while preserving managed static-analysis authority.

Every list has a deterministic order and hard limits. Search exposes scanned,
matched, returned, and dropped counts. An unresolved indirect call or a failed
signature decode is not silently omitted from a completeness claim.

## Obfuscation-resistant method slices

Names are one weak feature among many. A behavior slice records the smallest
bounded set of observations needed to investigate a proposition:

- normalized declaring/member signatures and inheritance/interface shape;
- framework and application API references;
- exact strings, numeric constants, enum-like values, and serialization keys;
- branch, switch, exception, loop, call, and field-flow shape;
- construction and generic-instantiation sites;
- exact body and normalized-CIL commitments;
- callers, callees, shared fields, and competing candidates; and
- limitations from reflection, dynamic dispatch, generated code, protection,
  native transitions, or incomplete coverage.

The workflow produces separate observation, inference, validation, and unknown
tables. It may say that a method is a strong candidate for a role; it cannot
turn that role into the method's durable identity.

Cross-version matching is two-stage:

1. Exact identity requires compatible artifact/module commitments and an exact
   entity/body identity.
2. Structural identity compares schema-versioned signatures, normalized CIL,
   APIs, constants, and bounded graph context. It reports all candidates at the
   winning score and remains ambiguous when the evidence does not distinguish
   them.

Tokens are always remapped through observed structure. A caller cannot carry
`0x06001234` into a new MVID and assume it names the same method.

## Managed/native boundary rules

| Boundary                | Managed observation                                                     | Native observation                                                               | Permitted link                                                       |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P/Invoke                | Module, entry point, charset/calling-convention flags, declaring method | Import/export/symbol/function evidence from the selected deep provider           | Exact declared-name/module link or qualified resolution inference    |
| COM                     | Interop attributes, GUIDs, imported interfaces, method signatures       | Native registration/vtable evidence when independently available                 | Identifier/signature inference with explicit environment limitations |
| C++/CLI                 | Managed declaration and implementation flags                            | Native body/function evidence                                                    | Only a provider-supported bridge observation; never token-as-address |
| ReadyToRun              | Component/header and per-method CIL/native availability                 | Native section/function evidence                                                 | Authenticated image mapping with format/profile version              |
| Unmanaged export        | Export metadata/attribute when present                                  | PE export and native thunk/function                                              | Exact export identity plus provider-qualified address                |
| Single-file host        | Bundle entry/component identity                                         | Host and native component evidence                                               | Outer bundle plus component digest/extent commitment                 |
| Unity IL2CPP            | Supported metadata entity with authenticated pairing                    | Generated native function/type evidence                                          | Versioned IL2CPP mapping only; no invented CIL                       |
| Runtime-resolved native | API/constant/data-flow candidate                                        | Loaded-module/symbol observation only under separate runtime execution authority | Static candidate remains inference until separately observed         |

Declared import inventory supports a bounded positive claim. Its absence does
not exclude dynamic resolution, generated code, protected code, native helpers,
or server-side behavior.

## Tool and packaging boundary

The production parser is REA-owned TypeScript and ships with the existing Node
application. It is verified against the ECMA-335 format and independent pinned
oracles but has no runtime dependency on them.

- `System.Reflection.Metadata` is the primary independent metadata/CIL oracle.
- `ICSharpCode.Decompiler` and `ilspycmd` are reconstruction and differential
  oracles. An admitted BYO reconstruction operation records its exact version
  and remains non-canonical. When `REA_ILSPY_CMD_PATH` points to an absolute
  runnable `ilspycmd`, `verify:managed` runs a source-owned real ILSpy oracle
  and imports its C# output as reconstruction inference against exact static
  member Evidence.
- dnlib and Mono.Cecil may increase differential coverage. Their mutation APIs
  are not exposed or included in the production parsing boundary.
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

## Source-built conformance corpus

Fixture sources are intentionally small and behavior-focused. Build outputs
are generated outside tracked fixture directories and must not remain after
verification or packaging.

| Corpus slice           | Required properties                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Identity               | Assembly/module/version/culture/public key, references, attributes, resources, MVID        |
| Signatures             | Nested/generic types, arrays, pointers, by-ref, function pointers where supported, varargs |
| CIL                    | Short/long branches, switch, prefixes, constants, locals, calls, fields, boxing, tokens    |
| Exceptions             | Catch, finally, fault/filter where the compiler/toolchain supports them                    |
| Generated structure    | Async and iterator state machines, lambdas, closures, properties, events                   |
| Interop                | P/Invoke flags, module/name mapping, managed/unmanaged implementation metadata             |
| Architecture           | AnyCPU, preferred-32-bit where applicable, x86, x64                                        |
| Obfuscation resistance | Unicode/meaningless/duplicate-looking names and structure-preserving renames               |
| Cross-build comparison | At least two builds with changed MVID/token order/layout and known same/changed behaviors  |
| Malformed/adversarial  | Truncated/overflowing headers, streams, tables, heaps, signatures, bodies, and EH sections |

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
  "schema_version": 1,
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
page of a large application. `il_length` remains accepted as a legacy alias for
`il_size`; optional `il_sha256` locks the exact raw CIL bytes in addition to
REA's schema-versioned normalized instruction digest.

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

## Runtime admission boundary

The later runtime track is not an extension flag on a static operation. Its
design must expose whether it attaches to an existing process, launches a new
process, loads an assembly, uses reflection, installs a debugger/profiler, or
instruments code. Each effect needs separate approval and exact-build checks.

At minimum, admission requires target SHA-256, MVID, normalized signature and
body/CIL commitment, CLR family, OS, architecture, tool version, scenario
limits, output policy, and cleanup ownership to match. Any mismatch fails before
the experiment. It must not contact real services/accounts or claim that an
instrumented path represents an ordinary launch unless that proposition is
independently tested.

The shipped `plan_managed_runtime_correlation` path admits only a
default-disabled, permission-gated experiment plan and records that no target
code was executed. Until a separate executor is designed and shipped, runtime
behavior questions remain explicit unknowns with suggested probes; static
support does not perform them.

## Delivery sequence

The managed-code track advances as reviewable pull requests:

1. accepted evidence/provider boundary (this document and ADR);
2. read-only artifact triage and exact identity (shipped);
3. bounded metadata, signatures, method bodies, and normalized CIL (shipped);
4. obfuscation-resistant slices and cross-version comparison (shipped for
   static member observations);
5. decompiler reconstruction import (shipped as analyst inference; REA does
   not run ILSpy/dnSpy, and metadata/CIL remain canonical);
6. managed/native composition and truthful deployment degradation (declaration
   inventory and native export/function Evidence matching shipped; native-body
   bridge mapping remains planned);
7. source-built managed conformance and package/CLI verification (source-owned
   PE/CLI corpus shipped through `npm run verify:managed`; optional BYO
   `ilspycmd` real-tool oracle shipped through `REA_ILSPY_CMD_PATH`; dnSpy and
   pinned Windows checks remain planned); and
8. separately authorized runtime-correlation admission planning (shipped; no
   runtime execution);
9. managed static Evidence projection into the application graph (shipped).

Each implementation PR updates generated product facts only for behavior it
actually ships and states which real-tool checks were performed.
