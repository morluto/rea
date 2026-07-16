# Managed-code analysis plan

This document turns
[ADR-0003](adr/0003-managed-code-evidence-and-provider-boundary.md) into an
implementation and verification plan. It describes planned behavior, not
shipped tools. The current product inventory remains the one in
[`product-catalog.json`](product-catalog.json).

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
   IL2CPP pairs linked to selected Hopper/Ghidra evidence.

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

| Boundary                | Managed observation                                                     | Native observation                                                     | Permitted link                                                       |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P/Invoke                | Module, entry point, charset/calling-convention flags, declaring method | Import/export/symbol/function evidence from the selected deep provider | Exact declared-name/module link or qualified resolution inference    |
| COM                     | Interop attributes, GUIDs, imported interfaces, method signatures       | Native registration/vtable evidence when independently available       | Identifier/signature inference with explicit environment limitations |
| C++/CLI                 | Managed declaration and implementation flags                            | Native body/function evidence                                          | Only a provider-supported bridge observation; never token-as-address |
| ReadyToRun              | Component/header and per-method CIL/native availability                 | Native section/function evidence                                       | Authenticated image mapping with format/profile version              |
| Unmanaged export        | Export metadata/attribute when present                                  | PE export and native thunk/function                                    | Exact export identity plus provider-qualified address                |
| Single-file host        | Bundle entry/component identity                                         | Host and native component evidence                                     | Outer bundle plus component digest/extent commitment                 |
| Unity IL2CPP            | Supported metadata entity with authenticated pairing                    | Generated native function/type evidence                                | Versioned IL2CPP mapping only; no invented CIL                       |
| Runtime-resolved native | API/constant/data-flow candidate                                        | Loaded-module/symbol observation only under future runtime authority   | Static candidate remains inference until separately observed         |

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
  and remains non-canonical.
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
operator. A compact manifest contains:

```json
{
  "schema_version": 1,
  "target": {
    "sha256": "<exact target digest>",
    "mvid": "<exact module MVID>",
    "assembly_name": "<expected simple name>",
    "architecture": "<expected classification>"
  },
  "methods": [
    {
      "label": "operator-local semantic label",
      "token": "0x06000000",
      "signature": "<normalized signature>",
      "il_length": 0,
      "normalized_il_sha256": "<digest>"
    }
  ]
}
```

Before evaluating methods, the verifier fails closed on any target commitment
mismatch. Output contains assertion status and compact identities only. It does
not print method bodies, reconstructed C#, application data, runtime telemetry,
account/service details, or full filesystem inventories. The manifest and
target remain outside git.

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

Until that capability is separately designed and shipped, runtime questions
remain explicit unknowns with suggested probes; static support does not perform
them.

## Delivery sequence

The managed-code track advances as reviewable pull requests:

1. accepted evidence/provider boundary (this document and ADR);
2. read-only artifact triage and exact identity;
3. bounded metadata, signatures, method bodies, and normalized CIL;
4. obfuscation-resistant slices and cross-version comparison;
5. managed/native composition and truthful deployment degradation;
6. source-built, pinned real-tool, package, CLI, and MCP conformance; and
7. separately authorized runtime correlation.

Each implementation PR updates generated product facts only for behavior it
actually ships and states which real-tool checks were performed.
