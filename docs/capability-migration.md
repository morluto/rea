# Incremental capability migration

This working guide tracks the migration in #740. Update it as concrete domains
migrate. Existing public contracts and domain-specific ports remain authoritative;
there is no new universal provider interface or fixed module manifest.

## Ownership to preserve

| Responsibility                                | Current owner                            | Migration direction                                            |
| --------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Analyst semantics and Evidence representation | domain                                   | Keep pure and provider-neutral                                 |
| Named public input/output contracts           | contracts                                | Keep exact CLI/MCP meaning and complete discovery              |
| Producer parsing and external tool protocols  | provider adapters                        | Keep behind the relevant typed port                            |
| Shared analyst workflows                      | application                              | Share between CLI and MCP                                      |
| Concrete provider construction                | binary runtime, composition, MCP startup | Consolidate one capability at a time in production composition |
| Investigation Evidence and Unknowns           | InvestigationRecords/EvidenceLedger      | Consume narrow read/write/atomic record ports                  |
| Target/profile snapshots and invalidation     | BinarySessionRecords/BinarySession       | Keep binary-owned                                              |
| Subprocess ownership and host primitives      | process/windows                          | Reuse; preserve cancellation and cleanup                       |
| Public translation                            | CLI/MCP adapters                         | Delegate to shared workflows and named contracts               |

Retain exact Evidence IDs, provenance, detached reads, atomic Evidence/Unknown
mutations and optimistic revisions. Preserve current close and failed-cleanup
record clearing while extracting ownership; #721 owns any retention-policy change.
Each CLI invocation and MCP connection keeps its own state. Provider registration
must not launch engines or install prerequisites.

## Migrate before generalizing

1. Record the actual callers, state, environment, protocol and verification owner
   of the capability being migrated.
2. Move concrete construction behind its existing typed port. Preserve injected
   ports, selected environment, queues, failure state and cleanup behavior.
3. Test both caller paths and the applicable package/real-provider boundary.
4. Use independently migrated capabilities to identify repeated metadata and
   composition needs. Derive a small source declaration only when those needs
   are established; keep unlike target/lifecycle semantics separate.
5. Move a coherent capability's files, fixtures and verification lanes in a
   mechanical PR. Update all path-sensitive consumers in that same PR.

Pure helpers do not need an interface each. A capture-format adapter or typed
factory may be sufficient. Avoid generic JSON execution, external MCP catalog
passthrough, eager provider acquisition, new permission fields or a multi-package
rewrite. Optional loading should preserve successful peers and report the failed
capability without hiding tools from the catalog.

## Checks before and after a move

`npm run verify:test-discovery` compares actual Vitest file discovery with every
repository-owned `*.test.ts` under src and tests, including newly added files. The
check requires Git, includes untracked non-ignored tests, and excludes removed
paths during a move. It
rejects missing files and overlapping project ownership. It only lists files;
it does not replace behavior tests or real-provider verification.

Check imports, project isolation and coverage, development-test selection,
lint exceptions, catalog/generator imports, npm and CI verification entrypoints,
fixture ownership, and installed-package bridge/native path resolution.
Domain and contracts must not import application workflows, caller adapters or
provider implementations. Production composition is a deliberate outer boundary.
Other existing adapter imports will migrate incrementally; do not widen a lint
exception to conceal new protocol code inside application workflows.

`npm run verify:module-boundaries` parses repository-owned source imports,
reexports, type imports and literal dynamic imports, then checks their resolved
source layer. Nested names such as `domain/android` are domain code; `src/android`
is the provider adapter. The check runs with lint, including cached static gates.
It covers tracked and untracked non-ignored TypeScript source and skips cached
paths removed during a move. Pass exact source paths for a focused check.

Pure source and its tests keep inward dependencies. Application/server provider
construction guards cover the migrated deep, Android, firmware, JavaScript recovery and observation
implementations. The existing binary runtime is an exact temporary composition
exception; shared browser capture/export helpers remain admitted while their
ownership is reviewed. Test lane restrictions still use Oxlint. Producer-dependent
browser and managed comparison tests live in boundary lanes with their original
fixtures and assertions. This is a development guard, not runtime authorization.

Select verification by the claim changed: schema/composition, package, real
engine or host-native workflow. Record host/target prerequisites and source-owned
fixtures. Run heavy lanes serially with bounded workers/heaps and reuse existing
engines. Recording ports do not prove real provider or platform support.

## Extension examples to validate during migration

An implementation of an existing port should require a provider adapter, typed
production factory selection, exact producer parsing/provenance and matching
verification. Existing workflow meaning and public contracts should stay stable.

A new analyst capability deliberately adds semantics, named contracts, a typed
port/workflow when needed, both caller adapters, availability, documentation and
verification. Its integration is broader than swapping a provider. The migration
should eliminate incidental duplicate wiring, not erase those design decisions.

Update these examples with real migrated entrypoints before closing #740.

## First production factory migration

`src/composition/android.ts` and `src/composition/firmware.ts` construct providers
behind the existing AndroidAnalysisPort and FirmwareAnalysisPort. CLI registrars
pass their selected environment; MCP uses the process environment unless a caller
injects a port. Each factory call returns a fresh instance and acquires no process,
workspace or toolchain. Queues, cleanup-failure state and per-request cleanup stay
inside the provider. The existing launcher seams remain available to boundary
fixtures, which now exercise the production factories.

Application workflows and MCP registration must not import these concrete
providers. Composition may import their implementations. Binary composition is
still at its existing entrypoint while its direct-analysis callers are investigated.
This concrete pilot does not introduce a shared provider interface or module
manifest.

## Independent optional observation adapters

Browser observation, browser scenarios, Electron observation, Electron scenarios
and V8 Inspector observation now have separate factories in `src/composition/`.
CLI commands reuse them; MCP startup dynamically imports each factory independently.
`OptionalObservationProviders` describes these five existing typed ports only. It
is provisional startup wiring, not an extensible plugin manifest or a universal
provider interface.

A failed import or constructor retains the successful peers. The complete tool
catalog remains advertised. Session availability reports the failed adapter and
its actual reason, and affected handlers return the existing capability-unavailable
error. Explicit loading failures take precedence over configured availability.
Passive Electron and active Electron failures are independent; static JavaScript
analysis and runtime reconciliation remain usable without either adapter. CLI
Electron commands also load only their selected runtime factory at execution.

Source identities are available without importing the optional implementations.
Registration acquires no engines, probes no endpoints, changes no permissions and
installs nothing. Core transport failures and shutdown still use their existing
lifecycle. Fault-injection coverage uses the production loading/startup path and
actual MCP SDK calls; recording ports establish composition behavior, while the
real Inspector lane separately establishes runtime behavior.

## Investigation record ownership pilot

`src/application/investigation/InvestigationRecords.ts` owns one existing
EvidenceLedger per runtime. The production session composition constructs that
owner explicitly; the direct BinarySession constructor retains a fresh default
for compatibility. There is no second ledger, global store, persistence or new
retention policy.

The ledger, Unknown Evidence helper and the ledger's two original behavior tests
now live beside the owner in `src/application/investigation/`. Bundle validation
and record-owner consumers follow the new paths; retained-reference access still
uses the narrow record ports. The move preserves implementation bodies and test
assertions. Binary snapshot/cache files remain with their existing owner.

EvidenceReader, EvidenceWriter and EvidenceUnknownWriter describe existing
read/write/atomic callback needs. UnknownRegistryPort preserves optimistic
revisions and consistency verification. Non-binary MCP registrars use these
record types without depending on the binary execution/lifecycle surface.
BinarySessionPort retains its compatible record methods through composition.

BinarySessionRecords remains the snapshot owner and compatibility facade. It
passes the actual active target explicitly for recordUnknown/updateUnknown;
recordEvidenceWithUnknown keeps its target-free mutation subject. Snapshot import
merges records without notifying midway, then emits after the cache commits.
Bundle import retains the full change delta so Unknown-only changes notify even
when recordsAdded is zero. Clearing resets records, cache and invalidation before
notification; observer failures remain best effort after a committed mutation.

Close and failed-cleanup clearing, ordinary target-switch retention, detached
reads, Evidence identities and deterministic bundle transfer keep their existing
behavior. Snapshots still require an active target and concrete analysis profile;
extracting investigation ownership does not make them a target-free record store.
#721 remains responsible for any future lifetime-policy change.

## Auxiliary source declaration pilot

Artifact, macOS native and managed static metadata now belongs to each adapter's
`*ProviderMetadata.ts` module. The implementation and
`src/composition/auxiliaryAnalysisProviders.ts` reuse the same identity and exact
capability descriptors. The declarations reference existing AnalysisProvider
loaders; they cover these three disjoint auxiliary implementations only. Deep
candidate selection and the five typed observation ports remain separate.

The binary runtime reads these source declarations while auxiliary construction
stays lazy. The separate managed-only entrypoint retains direct construction for
its execution-free workflow. The MCP catalog generator reads declarations without
constructing implementations, using its canonical macOS platform; actual runtime
host restrictions remain explicit.
Discovery and binary operation-kind routing now consume canonical source contracts
rather than their generated JSON artifact. No declaration imports its generated
output. Generated catalog facts and public schemas stay unchanged.

All observation registrars resolve contracts by name. An isolated compiled-process
test reverses presentation arrays and performs actual MCP SDK calls to verify
advertised schemas and handler meaning. Reordering metadata must not select a
different operation, schema, provider or deep-provider priority.
