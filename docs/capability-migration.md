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
| Investigation Evidence and Unknowns           | BinarySessionRecords                     | Extract one composed record owner after caller migration       |
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
