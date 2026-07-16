# ADR-0001: Provider selection and analysis profiles

- Status: Accepted
- Date: 2026-07-15
- Implementation status: The provider registry, deterministic selection,
  target binding, analysis-profile commitment, and snapshot/Evidence migration
  are implemented. Ghidra discovery, target/profile resolution, doctor checks,
  the private headless-session foundation, ten read-only inventory capabilities,
  and eight function-analysis capabilities are implemented with real
  cross-format conformance.

## Context

Before this decision, REA composed the artifact, native macOS, and Hopper
providers with `CompositeProvider`. That class intentionally requires every
operation to have one route. Hopper and Ghidra will both implement the deep
static-analysis operation family, so putting both into that composite would
either fail at construction or make array order an undeclared selection policy.

The active `BinarySession` also owned one composite client. `open_binary` had no
provider selector, and the domain `BinaryTarget` contained Hopper loader
arguments. Analysis snapshot v1 committed those loader arguments and each
cached entry's provider identity, but it did not commit the selected analysis
engine, engine version, or complete analysis configuration. Two analyses of the
same bytes could therefore disagree because of language, compiler, loader,
analyzer, or provider-version differences while appearing target-compatible.

These constraints are embodied in the current
[`CompositeProvider`](../../src/application/CompositeProvider.ts),
[runtime composition](../../src/application/runtime.ts),
[`BinarySession`](../../src/application/BinarySession.ts),
[`BinaryTarget`](../../src/domain/binaryTarget.ts),
[analysis snapshot](../../src/domain/analysisSnapshot.ts), and
[session lifecycle inputs](../../src/contracts/sessionLifecycleInputs.ts).

The next deep provider must not weaken the existing product invariants:

- stable provider-neutral CLI and MCP tool names;
- exact provenance and explicit unavailable or degraded capabilities;
- CLI and MCP parity;
- no silent provider fallback;
- provider-specific code outside the domain and application models;
- local, actionable diagnostics with only genuine secrets redacted; and
- snapshot reuse only when semantic analysis inputs are identical.

## Decision drivers

1. Hopper and Ghidra need to declare overlapping operations without ambiguous
   dispatch.
2. A target must have one explainable deep-analysis producer for its lifetime.
3. Target-free discovery must remain useful and must not start an analysis
   process.
4. Existing Hopper-only configurations must keep working when no selector is
   supplied.
5. Adding a second installed provider must not silently change results.
6. Snapshot and Evidence compatibility must include every setting that can
   materially change analysis.
7. Provider-specific open settings must not leak into `BinaryTarget` or become
   generic application fields.

## Terminology

- **Deep provider**: an engine such as Hopper or Ghidra that implements the
  overlapping static-analysis operation family.
- **Auxiliary provider**: a provider with a disjoint operation family, such as
  artifact inventory or native macOS inspection.
- **Candidate**: a registered deep provider before target selection.
- **Binding**: the selected deep provider and analysis profile attached to one
  active target.
- **Analysis profile**: a canonical commitment to the selected provider,
  provider version, and normalized semantic analysis settings.
- **Available**: the adapter and its required local runtime can be used on this
  host.
- **Supported**: the candidate accepts the parsed target and supplied open
  options. Availability and target support are separate observations.

## Decision

### 1. Separate disjoint composition from overlapping selection

`CompositeProvider` remains the mechanism for operation families whose routes
are disjoint. It must continue rejecting duplicate operation declarations. It
must not acquire priority, racing, fallback, or provider-selection behavior.

A new `AnalysisProviderRegistry` owns the configured deep-provider candidates.
Provider IDs are unique; duplicate IDs are a configuration error. The registry
may hold multiple candidates that declare the same operation. It performs
candidate discovery, target-support evaluation, option parsing, profile
resolution, and selection, but it does not choose a different provider for each
request.

After selection, the session composes exactly one bound deep provider with the
auxiliary disjoint families:

```text
                         target-free discovery
                                  |
                     AnalysisProviderRegistry
                       /                    \
                   Hopper                 Ghidra
                       \                    /
                        one selected binding
                                  |
        +-------------------------+-------------------------+
        |                         |                         |
  selected deep family     artifact family          native family
        +-------------------------+-------------------------+
                                  |
                            BinarySession
```

An auxiliary operation continues to report its actual auxiliary provider as
provenance. A deep operation always reports the provider in the active binding.
The synthetic composite identity is never evidence that two engines jointly
produced one observation.

Operation ownership is fixed by family:

| Operation family                                             | Executor                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Deep direct operations and provider-native function analysis | The one bound Hopper or Ghidra provider                                                               |
| Application-enhanced deep workflows                          | Application composition over the bound provider's declared operations                                 |
| Native macOS inspection                                      | The disjoint native provider                                                                          |
| Artifact inventory and extraction                            | The disjoint artifact provider                                                                        |
| Browser and Electron observation                             | Their independently authorized CDP providers; they do not participate in deep-provider selection      |
| Session lifecycle, Evidence, comparisons, and reconstruction | The application/session layer using the exact provider provenance recorded by their source operations |

Selecting a deep provider selects the whole deep family. If that provider marks
an operation unavailable, REA returns the unavailability; it does not borrow
that one operation from another deep provider. Application-enhanced workflows
run only when the bound provider supplies their declared dependencies.

### 2. Discover candidates without launching analysis

Each registered candidate exposes three bounded adapter-owned observations:

1. identity and declared capability descriptors;
2. host availability, including an actionable rejection when unavailable; and
3. target support plus normalized profile resolution when a target is known.

Target-free discovery may inspect configuration, manifests, executable
metadata, and documented version files. It must not import a target, create a
project, open a GUI, or start the long-lived analysis process. Any short-lived
version probe added later must be explicitly bounded and truthfully declared as
a process effect.

Candidate output is sorted by provider ID for determinism. Sort order is not
selection priority. Availability and support use stable codes plus a human
diagnostic:

| Code                         | Meaning                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `not_configured`             | Required provider location or configuration is absent           |
| `executable_missing`         | The configured provider entry point is missing or not runnable  |
| `runtime_missing`            | A required provider runtime, such as Java, is unavailable       |
| `unsupported_host`           | The host platform or architecture is unsupported                |
| `unsupported_version`        | The discovered provider or runtime version is unsupported       |
| `target_kind_unsupported`    | The provider does not accept this target kind                   |
| `target_format_unsupported`  | The provider does not accept this target format                 |
| `architecture_unsupported`   | The selected target architecture is unsupported                 |
| `target_role_unsupported`    | The provider rejects this executable image role                 |
| `managed_target_unsupported` | The provider does not admit managed code through this deep path |
| `open_options_invalid`       | The selected adapter rejected its open options                  |
| `version_unresolved`         | A concrete analysis-engine version could not be committed       |

Diagnostics retain useful local paths, observed versions, architectures, and
mismatch details. Credentials, authorization headers, license secrets, and
other genuine secrets remain redacted.

### 3. Use one deterministic selection algorithm

The caller-visible selectors are:

- MCP `open_binary.provider_id`;
- `rea ... --provider <provider-id|auto>` on every one-shot command that needs
  deep analysis; and
- `REA_ANALYSIS_PROVIDER=<provider-id|auto>`, defaulting to `auto`.

The literal value `auto` is reserved and cannot be a provider ID. Precedence is
request or CLI flag, then environment configuration, then the default `auto`.
An explicit request for `auto` overrides a concrete environment preference and
re-enters automatic selection.

Selection occurs after provider-neutral target parsing and before a deep client
is created:

1. A concrete requested provider ID must exist, be available, support the
   target, accept its options, and resolve a concrete version and profile. Any
   failure returns a typed selection error; another provider is never tried.
2. `auto` filters candidates by availability and target support.
3. Exactly one usable candidate is selected with source
   `auto-single-candidate`.
4. More than one usable candidate is an `ambiguous` selection error. The
   diagnostic lists the candidates and asks for `provider_id`, `--provider`, or
   `REA_ANALYSIS_PROVIDER`. REA does not prefer Hopper, Ghidra, registration
   order, the fastest startup, or the first health response.
5. When no deep candidate is usable, an automatic open may still establish an
   unbound target so disjoint artifact or native operations remain available.
   Deep operations are then explicitly unavailable with the candidate
   rejections. A concrete request, or a concrete environment preference for a
   deep-eligible target, remains a hard requirement and fails instead of
   becoming unbound.
6. A target that no deep adapter declares support for, such as an artifact-only
   target, is `not_applicable` rather than a failed deep analysis. Supplying a
   concrete provider in that open request is still an actionable unsupported-
   target error. A global environment preference does not make an artifact-only
   target require a deep provider.

This preserves target opening for non-Hopper capabilities on hosts without a
deep engine while ensuring that installing a second usable deep engine never
changes analysis silently.

### 4. Bind once and never fail over mid-session

An active deep binding contains:

```text
canonical target identity
selected provider identity and concrete version
selection source: request | environment | auto-single-candidate
analysis profile commitment
owned provider client, once started
```

The binding is immutable until `close_binary` or an explicit open/switch
transaction. Provider client creation may remain lazy, but laziness cannot
change which provider was selected.

- Opening the same canonical target without a new selector keeps the existing
  binding.
- Opening the same target with the same provider and profile is idempotent.
- A different explicit provider or a profile-changing option is a real switch:
  drain active calls, close owned resources, resolve the new binding, and start
  it as one serialized transaction.
- If a switch fails, restore the prior target and binding on a best-effort
  transactional path and return the original switch error.
- Provider process exit, timeout, cancellation, capability failure, or adapter
  error never triggers fallback. The binding stays visible and unavailable
  until the caller explicitly switches or closes it.
- A snapshot never chooses or changes the provider. Selection happens first;
  snapshot compatibility is checked against the resulting binding.

Calls already admitted to one binding complete or cancel against that binding.
No request can cross a concurrent target or provider transition.

### 5. Keep provider open options adapter-owned

`BinaryTarget` retains only provider-neutral source identity and classification:
canonical path, source digest, generic kind and format, selected architecture,
and available architectures. Hopper loader arguments leave the domain model.
Provider-owned databases use a generic analysis-database classification; their
adapter determines support. A legacy `.hop` target is therefore accepted only
by Hopper without teaching the domain how to open it. Ghidra v1 continues to use
private temporary projects and does not open user projects.

The generic transport may carry one bounded JSON `provider_options` object.
Only the selected adapter parses its keys and reports `open_options_invalid` at
that boundary. If this object is exposed over MCP, the CLI parity surface is
`--provider-options-json` with the same JSON schema and limits. Unknown keys,
wrong-provider options, excessive depth or size, and non-JSON values fail
closed.

Environment settings that are inherently adapter-specific, such as the Hopper
launcher or future Ghidra installation path, remain in adapter configuration.
They do not become `BinaryTarget` fields. The application layer transports an
opaque, already-bounded JSON value and the generic commitment described below;
it does not interpret Hopper or Ghidra option names.

### 6. Commit a canonical analysis profile

Before creating a deep client, the selected adapter normalizes every semantic
input that can affect analysis. Examples include Hopper loader selection and
architecture flags, or Ghidra language ID, compiler specification, import mode,
analyzer set, and analyzer options. Defaults are made explicit, unordered sets
are sorted, and implicit host-dependent choices are resolved.

The adapter returns this provider-neutral envelope:

```json
{
  "schema_version": 1,
  "provider": { "id": "ghidra", "version": "<concrete version>" },
  "provider_profile_schema_version": 1,
  "parameters": {},
  "digest": "<sha256 of RFC 8785 canonical JSON excluding digest>"
}
```

`parameters` is bounded JSON interpreted only by that provider adapter. It
contains analysis semantics, not credentials, authorization data, temporary
paths, installation paths, process IDs, timestamps, or other incidental host
state. The generic domain validates the envelope and digest but treats the
parameters as opaque data.

A selected deep binding requires a concrete provider version. If the adapter
cannot determine it, the candidate is unavailable with `version_unresolved`;
REA does not persist a cache that merely commits `null` or "whatever is
installed". Provider identity, provider-profile schema version, normalized
parameters, or provider version changes produce a different digest.

The same target, configuration, and provider must resolve the same profile over
CLI and MCP. Profile resolution must be side-effect-free and complete before
the provider imports the target.

### 7. Make snapshots provider- and profile-exact

Analysis snapshot v2 replaces Hopper loader arguments with an explicit binding
commitment:

```text
snapshot_version: 2
target: digest + generic format/kind + selected architecture
binding: provider identity + analysis profile commitment
entries: exact immutable queries
evidence_bundle: retained Evidence records
```

The snapshot target identity, canonical snapshot content digest, and every
query ID commit the provider ID, concrete provider version, and profile digest.
A cached entry is reusable only when all of the following match exactly:

- target digest, generic format and kind, and selected architecture;
- provider ID and provider version;
- profile schema versions and profile digest;
- operation and canonical parameters; and
- the existing cacheability and immutability rules.

Provider or profile switches select a separate cache partition and cannot reuse
entries from the previous binding. Auxiliary operations are cacheable only if
their provider defines an equivalent explicit profile commitment; otherwise
they remain Evidence but not snapshot entries.

Snapshot v1 is not silently upgraded. Its `loader_args` cannot prove which
engine version, defaults, or analyzer settings produced the entries. Importing
v1 returns a typed incompatibility with a recapture instruction. Its embedded
Evidence bundle may still be imported separately through the existing explicit
Evidence import flow; it is never promoted into a v2 analysis cache.

### 8. Add profile commitments to new deep Evidence without rejecting legacy Evidence v2

Evidence remains schema version 2. A backward-compatible optional
`analysis_profile` field uses the canonical envelope above. Every newly created
deep-analysis observation must include it, and its provider ID and version must
match the record's provider. The field participates in the Evidence semantic ID.

Existing Evidence v2 records without `analysis_profile` remain valid and keep
their existing IDs. Absence on a legacy deep record means the analysis profile
is unknown; REA does not infer or enrich it during import. Such evidence can be
displayed and cited but cannot establish profile compatibility, seed snapshot
replay, or support an "unchanged" conclusion that depends on identical analysis
semantics.

Different providers or profile digests are never snapshot-compatible. A
derived comparison may compare cross-provider normalized facts only when its
own contract explicitly defines that semantic comparison. Exact pseudocode,
provider text, or provider-specific metadata is not treated as equivalent. A
missing or incompatible profile yields unknown or incompatible, never equal.

### 9. Expose selection truth in status and diagnostics

`binary_session`, `rea providers`, and `rea capabilities` expose the same
candidate and binding model. The target-free form does not start providers and
uses `unknown` for target support:

```json
{
  "analysis_provider_binding": null,
  "analysis_provider_candidates": [
    {
      "provider": {
        "id": "hopper",
        "name": "Hopper Disassembler",
        "version": "<detected version>"
      },
      "availability": {
        "status": "available",
        "code": null,
        "reason": null,
        "diagnostics": {}
      },
      "target_support": {
        "status": "unknown",
        "code": null,
        "reason": "No target is open."
      },
      "selected": false,
      "capabilities": []
    }
  ]
}
```

With a binding, `analysis_provider_binding` includes the selected identity,
selection source, and complete profile commitment. Every candidate reports
`supported`, `unsupported`, or `unknown` target support and whether it was
selected. Candidate capability descriptors preserve supported, unsupported,
and degraded truth independently.

The existing flat `provider`, `providers`, and `capabilities` status fields stay
during the 1.x compatibility window. Their effective deep-operation entries
come only from the active binding; target-free ambiguity is unavailable rather
than arbitrarily collapsed. The new candidate fields are authoritative for
selection. A future major release may remove the synthetic composite provider
field after callers have migrated.

Selection failures extend the tagged `ProviderSelectionError` with a stable
reason:

- `unknown_provider`;
- `provider_unavailable`;
- `target_unsupported`;
- `ambiguous`;
- `invalid_options`.

The error includes the requested ID or `auto`, candidate IDs, rejection codes,
and actionable local diagnostics. `AnalysisCapabilityUnavailableError` remains
the error for an operation the selected provider cannot supply.
`ProviderAdapterError` and more specific provider errors remain failures of the
already selected provider. None authorizes fallback.

A snapshot whose provider or profile differs from the selected binding returns
`EvidenceIntegrityError` with stable `profile_mismatch` details. It is an
integrity incompatibility after selection, not permission to select the
snapshot's provider.

### 10. Preserve CLI and MCP parity

- `open_binary.provider_id` and one-shot `--provider` use the same parser and
  selection service.
- `provider_id: "auto"`, `--provider auto`, and
  `REA_ANALYSIS_PROVIDER=auto` have identical auto semantics.
- Startup targets opened from environment configuration use the same service.
- `rea providers`, `rea capabilities`, and target-free `binary_session` use the
  same candidate snapshot and reason codes.
- Guided prompt `provider_id` context is a preference to forward into the open
  operation; it does not create a hidden routing channel.
- Tool names and normalized output contracts remain provider-neutral. REA does
  not add `ghidra_decompile` or `hopper_decompile` tools.

## Compatibility and migration

| Existing behavior or data                            | Decision                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No provider selector, only Hopper usable             | `auto` selects the sole candidate; behavior remains equivalent                                                 |
| No deep provider usable                              | Automatic open may remain unbound for auxiliary operations; deep capabilities explain why they are unavailable |
| Hopper and Ghidra both usable, no preference         | Open fails with `ambiguous`; installation order never becomes policy                                           |
| Existing Hopper environment settings                 | Remain supported as Hopper adapter configuration                                                               |
| `open_binary` and CLI structured `loaderArgs` output | Retained as a deprecated Hopper-only compatibility projection for 1.x; the analysis profile is authoritative   |
| `BinaryTarget.loaderArgs`                            | Removed; Hopper derives them inside its adapter and commits normalized semantics in the profile                |
| Legacy `.hop` input                                  | Classified generically as an analysis database and accepted only by Hopper                                     |
| Snapshot v1                                          | Rejected for cache replay with explicit recapture guidance; embedded Evidence may be imported separately       |
| Existing Evidence v2 without a profile               | Accepted unchanged; profile compatibility is unknown                                                           |
| New deep-analysis Evidence v2                        | Must include `analysis_profile`; its semantic ID commits the field                                             |
| Existing status fields                               | Retained for 1.x with additive binding and candidate fields                                                    |
| Provider failure after selection                     | Returned from the selected provider; no transparent retry through another engine                               |

The deprecated `loaderArgs` response must never be read to select a provider or
validate a snapshot. It is empty for non-Hopper bindings and may be removed only
with a separately documented major contract change.

## Required behavior scenarios

| Scenario                                                   | Result                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Hopper is the only usable candidate, selector omitted      | Hopper is bound by `auto-single-candidate`                                  |
| Ghidra is the only usable candidate, selector omitted      | Ghidra is bound by `auto-single-candidate`                                  |
| Both are usable, selector omitted                          | Typed `ambiguous` error; neither provider starts                            |
| Environment selects Ghidra, request omits a selector       | Ghidra is required and bound or the open fails with its rejection           |
| Environment selects Ghidra, request selects Hopper         | Request wins; Hopper is required                                            |
| Environment selects Ghidra, request selects `auto`         | Auto policy runs and is ambiguous when both are usable                      |
| Unknown concrete provider ID                               | Typed `unknown_provider`; no target transition                              |
| Selected provider rejects the target or options            | Typed rejection from that candidate only                                    |
| Selected provider times out after binding                  | Binding remains selected and unavailable; no fallback                       |
| Same target is reopened without a selector                 | Existing binding remains unchanged                                          |
| Same bytes are opened with a different profile             | Real provider switch and a separate snapshot partition                      |
| Snapshot provider or profile differs from the binding      | Typed `EvidenceIntegrityError` with `profile_mismatch`; nothing is imported |
| Snapshot v1 is supplied                                    | Typed incompatibility with recapture or explicit Evidence-import guidance   |
| Artifact-only target has no deep candidate                 | Target opens unbound; disjoint artifact capabilities remain usable          |
| Environment prefers Ghidra for an artifact-only target     | Deep selection is `not_applicable`; auxiliary operations remain usable      |
| Concrete deep provider is requested for artifact-only data | Typed `target_unsupported`; the request is not silently ignored             |

## Consequences

Positive consequences:

- Hopper and Ghidra can coexist without ambiguous operation routes.
- Provider choice is reproducible, visible, and stable for a target.
- Installation of another provider cannot silently change analysis.
- Snapshot and Evidence identities become analysis-configuration aware.
- Provider adapters retain ownership of their option schemas and diagnostics.
- Auxiliary capabilities remain usable when no deep engine is installed.

Costs and tradeoffs:

- Multi-provider hosts must choose when more than one candidate is usable.
- Snapshot v1 cannot safely serve as a cache after this migration.
- Providers must expose deterministic availability, support, version, and
  profile resolution before they can be admitted.
- Status and error contracts gain additive structured metadata.
- Hopper needs an adapter-owned version/profile implementation before profile-
  exact snapshot persistence is complete.

## Rejected alternatives

### Let `CompositeProvider` choose the first duplicate route

Array order is not a product policy, becomes fragile during wiring changes, and
hides ambiguity from callers.

### Race providers and keep the first healthy response

Machine load would determine provenance and results. It also starts resources
the operator did not select and makes cancellation and cleanup harder.

### Fall back after a provider error

Mid-session fallback can combine incompatible engine state and evidence under
one apparent target. Explicit close or switch is required instead.

### Add provider-prefixed tools

Parallel Hopper and Ghidra tool families would leak adapters into the product
contract and prevent shared workflows from using capability metadata.

### Store raw provider options in `BinaryTarget`

That repeats the current Hopper coupling and makes every generic consumer learn
provider schemas. Only canonical profile commitments cross the adapter boundary.

### Treat matching target bytes and provider ID as sufficient for snapshots

Provider versions, analyzer defaults, loaders, languages, and compiler models
can change results without changing either value.

### Silently upgrade snapshot v1

The missing engine version and analysis settings cannot be reconstructed from
Hopper loader arguments. A fabricated profile would turn unknown provenance
into false certainty.

## Implementation progress

The first six implementation stages are shipped:

1. Provider-specific target state was replaced by generic profile and snapshot
   v2 commitments while preserving Hopper execution behavior.
2. The registry, selectors, candidate status, binding lifecycle, and
   overlapping-provider production seams were added.
3. Proven process-lifecycle primitives were extracted for shared use.
4. Ghidra availability, target/profile resolution, doctor checks, and a private
   read-only headless session were admitted without declaring operations.
5. Program identity, procedures, strings, symbols, memory blocks,
   address/name resolution, containing-procedure resolution, and bounded search
   were admitted with exact wire schemas and real debug/stripped ELF
   conformance.
6. Function metadata, persistent bounded decompilation, assembly, resolved
   callers/callees, typed references, xrefs, CFG, and complete function dossiers
   were admitted. A bounded per-Program queue serializes API access, and real
   conformance covers x86-64 and AArch64 ELF, PE, Mach-O, stripped symbols,
   targetless indirect calls, cancellation, deadlines, and cleanup.

Future stages may deepen format and indirect-flow coverage, but must continue
to compare normalized semantics rather than provider-specific pseudocode or
assembly text. Ghidra continues to omit GUI and mutation operations, so
unsupported requests cannot route to an unverified implementation.
