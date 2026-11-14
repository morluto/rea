# Antidote canonicalization — implementation plan

## Approach

Mirror REA's existing in-process, target-free analyzer stack (ELF notes / byte
entropy): a pure domain engine, a shared application service, a bounded
stable-read provider, one tool contract, composition, and the CLI + MCP
adapters. Keep the engine pluggable and config-driven so new shields and formats
are declarative additions.

## Steps

1. Domain engine (`src/domain/canonicalize/`): schemas + budget constants, the
   `ArtifactNormalizer` interface and uniform fact model, the selection engine,
   and the WASM / `.asar` / JSON normalizers.
2. Provider identity `CANONICALIZE_PROVIDER` in `investigationProviders.ts`.
3. Application `CanonicalizePort` + `CanonicalizeService` (validate → provider →
   Evidence), following `ElfNotesService`.
4. In-process `CanonicalizeProvider` over the shared stable artifact reader.
5. Contract `canonicalize_artifact` + effect audit entry; wire into the catalog,
   the native tool family, capability services and capability declarations.
6. Adapters: `rea antidote` CLI command and the `canonicalize_artifact` MCP tool
   registration, plus the CLI↔tool coverage alias.
7. Tests and docs.

## Extension points touched

- `src/contracts/toolEffects.ts` (effect audit), `toolContracts.ts` and
  `toolFamilies.ts` (catalog + native family), `cliCommandNames.ts`,
  `cli.ts` and `server/createServer.ts` (adapter registration),
  `composition/capabilityServices.ts` and `capabilityDeclarations.ts`
  (service + provenance), `scripts/lib/test-projects.mjs` (new source dir),
  and `tests/boundary/cli/cliToolCoverage.test.ts` (alias).
- `src/domain/artifactOperationError.ts` gains `canonicalize_artifact` in the
  stable-artifact failure operation union.

## Decisions

- **Family**: the native family, reusing the simple target-free analyzer
  registration (plain Evidence handler, no session dispatch). The native family
  already hosts the format-agnostic `inspect_byte_entropy`, so a multi-format
  canonicalizer is consistent there; this avoids a new tool-family id and its
  env-selection wiring.
- **Naming**: user-facing command and headline concept `antidote`; internal
  engine, modules and the MCP operation verb `canonicalize`. The MCP tool is
  `canonicalize_artifact` to match REA's `verb_noun` convention; the CLI command
  and documentation lead with "antidote".
- **No new runtime setting / env var.** The feature is opt-in by being a
  separate tool; its budgets are per-call parameters, so no `REA_*` limit is
  added.
