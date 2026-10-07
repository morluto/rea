# Incremental capability migration

This working guide tracks the migration in #740. Update it as concrete domains
migrate. Existing public contracts and domain-specific ports remain authoritative;
there is no new universal provider interface or fixed module manifest.

## Ownership to preserve

| Responsibility                                | Current owner                       | Migration direction                                   |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| Analyst semantics and Evidence representation | domain                              | Keep pure and provider-neutral                        |
| Named public input/output contracts           | contracts                           | Keep exact CLI/MCP meaning and complete discovery     |
| Producer parsing and external tool protocols  | provider adapters                   | Keep behind the relevant typed port                   |
| Shared analyst workflows                      | application                         | Share between CLI and MCP                             |
| Concrete provider construction                | composition, MCP startup            | Keep fresh typed factories at the production boundary |
| Investigation Evidence and Unknowns           | InvestigationRecords/EvidenceLedger | Consume narrow read/write/atomic record ports         |
| Target/profile snapshots and invalidation     | BinarySessionRecords/BinarySession  | Keep binary-owned                                     |
| Subprocess ownership and host primitives      | process/windows                     | Reuse; preserve cancellation and cleanup              |
| Public translation                            | CLI/MCP adapters                    | Delegate to shared workflows and named contracts      |

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
implementations. Application workflows cannot import composition, including the
former binary runtime entrypoint; shared browser capture/export helpers remain admitted while their
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
providers. Composition may import their implementations. Binary composition also
uses this outer boundary after its direct-analysis callers were migrated.
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

## Inspector adapter ownership

`src/inspector/` owns V8 Inspector discovery, passive capture, script/target
location interpretation and its lightweight provider identity. The composition
factory and optional loader use this owner. Browser CDP connection, endpoint/value
and Electron file-location helpers remain deliberate shared adapter utilities at
their existing paths; no provider wire protocol moves into domain or process.

Loopback fixtures and producer boundaries now live under
`tests/fixtures/inspector/` and `tests/boundary/inspector/`. The socket-backed
unresolved-target reconciliation test moves from composition into the forked
boundary lane with its original assertions. Adapter tests retain fork isolation.
`npm run verify:inspector` keeps its public development entrypoint and delegates
to `scripts/verify/inspector/runtime-observation.mjs`, using the real Node fixture
under `tests/conformance/inspector/`. Catalog imports, source guards and test
discovery follow the new paths. Observation authority, lifecycle, producer
interpretation and caller-visible contracts stay unchanged.

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

## Android layer and verification ownership

Android workflows and their existing typed port live in `src/application/android/`,
pure APK/inventory semantics in `src/domain/android/`, and the named inspection
contracts in `src/contracts/android/`. The headless JADX producer remains in
`src/android/`; `src/composition/android.ts` supplies its fresh factory to both
caller adapters. Public names, result meaning and JVM/queue/cleanup limits are
unchanged. Inventory-only application projection remains execution-free.

The real lane and signal-cleanup helper belong to `scripts/verify/android/`; its
explicit downloader and fixed manifest belong to `scripts/fixtures/android/`.
`verify:android` and `fixtures:android` keep their command names and repository-root
`_reference/apk-integration/` fixture default. Synthetic producer fixtures stay in
`tests/fixtures/android/`, with matching boundary and composition ownership. Real
JADX CLI/MCP parity requires the fixed APK and existing audited JAR; synthetic
protocol/cancellation success does not establish that engine or an unverified host.

## Deep-provider source declarations

Hopper, Ghidra and IDA declare their implemented analyst operations in their
own `*ProviderCapabilities.ts` modules. Hopper's inventory is typed against the
existing direct-operation contracts; Ghidra reuses its inventory/function adapter
operations; IDA retains its read-only operation family. Frozen operation arrays
feed the existing capability builders without importing generated catalog data.

The catalog generator reads these source declarations and joins operation names
to canonical `TOOL_CONTRACTS`. A missing contract identifies the declaring provider
and operation. Public schemas and descriptions remain owned by contracts; the
declarations describe implementation coverage. Provider adapters must not consume
the generated MCP catalog that is derived from them. The resolved module guard
checks this edge while admitting canonical source contracts, generated package
metadata and the existing application snapshot-cache consumer.

Exact provider effects and lifecycle differences remain in their adapters:
Hopper's GUI and mutation effects, Ghidra's experimental Windows authority and
mutation restrictions, and IDA's attached/headless effects and live observations.
This source increment introduces no common provider lifecycle or new interface.

## JavaScript application ownership

`src/application/javascript/` owns JavaScript/Electron artifact analysis and
graph projection, feature/version/export/source comparisons, runtime Evidence
and reconciliation, observation ports, and source recovery workflows. Pure
analysis and public schemas keep their existing domain/contract ownership;
shared artifact inventory, investigation records and execution types remain
shared. CLI, MCP and production factories import the owning workflow directly.

`src/domain/javascript/` owns static parsing and semantic IR, application and
semantic graphs, Electron facts, runtime reconciliation, recovery result
semantics, and source-to-bundle comparisons. Shared Evidence, digests, ordering,
comparison semantics and historical-source graphs stay at their existing owners.
Native handoffs link exact-subject Evidence without selecting or executing a
provider.

`src/contracts/javascript/` owns the JavaScript/Electron observation and recovery
contracts, JavaScript-specific workflow requests, and their examples. The shared
`applicationToolContracts.ts` aggregate stays at the contract root because it also
owns reconstruction and Android/Apple projection operations. Canonical tool
aggregation, named handler binding and SDK schema presentation remain unchanged.
Catalog source paths, compiled verifier/SDK fixtures and recovery CI filters
follow the domain/contract owners.

`scripts/verify/javascript/` groups application-workflow, runtime-reconciliation,
large-digest and real-recovery entrypoints. Their existing npm commands retain
their invocation semantics. Recovery fixture compilation lives beside its
unchanged sources under `scripts/fixtures/javascript-recovery/`. Its default
REA entrypoint still resolves to `scripts/rea.mjs`. Managed conformance imports
the relocated compiled workflow; owning CI source filters follow the new paths.

`src/artifacts/javascript/` owns directory/ASAR reader construction and relevant
file acquisition, including root/nested byte verification, UTF-8 diagnostics and
nested reader cleanup. Its narrow factory returns the existing `ArtifactReader`;
the application retains input admission, inventory, graph construction and its
original root-reader `finally` close. Pure file facts live in
`src/domain/javascript/javascriptArtifactFiles.ts`, and the shared immutable
inventory snapshot lives in `src/domain/artifactInventorySnapshot.ts`. Inventory
options and integrity policy remain application-owned. Shared stream hashing
lives in `src/artifacts/ArtifactHash.ts`, preserving complete byte counts and the
bounded classification prefix. Acquisition/hash guards reject imports from
application, composition or caller adapters; JavaScript workflows use the factory
instead of importing concrete ASAR/directory reader classes.

ZIP, native-DMG and Mach-O inventory reader selection keep their existing
lifecycles. Runtime ports retain their distinct Inspector, passive Electron and
active Electron effects; shipped Electron hooks remain at their existing
provider boundary.

## Managed capability ownership

`src/domain/managed/` owns managed artifact and member semantics, reconstruction
import, native-boundary verification and application graph projection.
`src/application/managed/` owns their shared Evidence workflows, and
`src/contracts/managed/` owns their named contracts and examples. Producer
metadata/IL parsing stays in `src/dotnet/`; target resolution, Evidence, ordering
and investigation records retain their shared owners. Path-based member
comparison preserves its actual target/byte-digest admission and existing parser
helper.

`scripts/verify/managed/` groups the portable conformance entrypoint and its
support, manifest, oracle and completion-report helpers. Its PE byte fixture
builder and declaration live in `scripts/fixtures/managed/`, shared with the
installed-package lane and existing managed conformance tests. `verify:managed`
keeps its command name and optional caller-cwd manifest resolution. Compiled
catalog and generator imports follow the owners; document-check cache inputs
include the relocated runtime verifier and fixture files.

Portable byte fixtures, optional operator-local manifests, actual ILSpy oracles
and real Ghidra NativeAOT checks retain their distinct proof levels and
prerequisites. The existing NativeAOT fixture/engine lane keeps its owner. This
move preserves implementations, Evidence identities and generated commitments.

## Binary application ownership

`src/application/binary/` owns the active session, deep-provider registry and
evaluation, operation routing, disjoint provider composition, lazy auxiliary
clients, cancellation and client cleanup. Its records facade and snapshot
cache/files remain bound to the exact target and analysis profile. Investigation
records still have their separate owner in `src/application/investigation/`.

`AnalysisProvider.ts` stays shared because its identity/execution types also serve
nonbinary ports. `BinaryTargetResolver.ts` stays shared because Android, firmware,
managed and artifact workflows use its target parsing. Production wiring lives
in `src/composition/binary.ts`; application workflows gain no outward composition
dependency.

The three colocated application tests move with their owner. Composition cases
remain in `tests/composition/analysis-sessions/`; filesystem and SDK cases retain
their boundary lanes. The shared `tests/fixtures/binarySession.ts` factory supports
several capability families. Existing recursive application globs discover the
moved tests; bridge assets and real-verifier entrypoints remain at their owners.

## Firmware layer and verification ownership

Firmware workflows and their existing typed port live in
`src/application/firmware/`, pure request/result semantics in
`src/domain/firmware/`, and named contracts in `src/contracts/firmware/`.
`src/firmware/` keeps producer commands, report parsing, source copies, publication
and cleanup; `src/composition/firmware.ts` supplies a fresh typed factory.

The real lane belongs to `scripts/verify/firmware/analysis.mjs`; the fixture runner
and its unchanged Python producer belong together in `scripts/fixtures/firmware/`.
The npm command names and selected `REA_FIRMWARE_FIXTURE_ROOT` are unchanged. The
runner retains its working-directory-relative default; the verifier retains its
repository-root default. Both point to `_reference/firmware-integration/generated`
when invoked through the documented npm commands. Optional ext4/Ghidra lanes keep
their own prerequisites. Source-fixture generation and synthetic producer tests
do not establish real Binwalk/Unblob analysis or another host's execution support.

## Apple artifact capability ownership

`src/domain/apple/` owns Apple application anatomy/projection, asset catalog
facts, Interface Builder graphs, keyed archive semantics and plist values.
`src/application/apple/AppleApplicationService.ts` retains the shared workflow
that projects authenticated IPA/macOS inventory Evidence.

`src/artifacts/apple/` owns the actual producer boundary: directory acquisition,
assetutil invocation, plist/NIB decoding, encoded view-parent interpretation and
keyed archive inspection. These helpers are used by ArtifactProvider, retain
its existing typed analysis boundary, injected assetutil seam and original reader
cleanup, and do not require a new port for each helper. Producer code no longer
lives in the application layer. Guards reject application/composition/caller
imports from this owner while admitting pure facts and shared artifact readers.
Adapter-source tests retain their assertions in the existing forked adapter lane.

`scripts/verify/apple/` groups archive, asset catalog, Interface Builder,
Objective-C/Swift dispatch and macOS bundle verification. The macOS bundle fixture
builder lives in `scripts/fixtures/apple/`; NIB byte fixtures stay beside their
artifact decoder. Existing format-specific conformance sources and goldens keep
their locations, and relocated verifiers resolve them against their own file
URLs. Public npm entrypoints and CLI/MCP contracts stay stable; generated-document
cache inputs include the relocated runtime scripts and fixture builder.

Portable decoder and injected producer tests establish their format/boundary
claims. Actual Swift/Xcode, assetutil, native NIB, bundle signing and DMG lifecycle
claims require the real Apple lane. Native binary API/value-flow semantics and
shared cross-domain contract aggregates keep their separate owners.

## Binary production composition closure

`src/composition/binary.ts` is the shared production owner for deep candidate
construction, lazy auxiliary composition and the managed-only session factory.
It preserves the existing constructor bodies, selection policy and fresh session
per invocation. Factory registration acquires no engine or target.

`DirectAnalysis` and `DirectAnalysisStatus` receive these two existing factories
through `DirectAnalysisDependencies`. They retain configuration parsing, selected
status environment, cancellation, snapshot replay/binding, Evidence projection
and finally-close. The dependency uses the existing BinarySession type, including
its replay policy; it adds no universal backend or lifecycle contract.

`src/composition/directAnalysis.ts` binds the production factories for CLI and
one-shot managed MCP callers. Binding creates no session and stores no retained
analysis state. MCP startup constructs its connection session through the same
binary factory. Source and compiled fixtures use these entrypoints. The former
application runtime path is removed, and the source guard no longer admits its
outward provider/composition imports.
