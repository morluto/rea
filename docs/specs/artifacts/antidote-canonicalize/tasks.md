# Antidote canonicalization — tasks and verification

## Status

- [x] Domain engine: schemas, normalizer interface, selection engine.
- [x] Normalizers: WASM sections, Electron `.asar` header, structured JSON.
- [x] Application port + service; in-process provider over the stable reader.
- [x] Contract, effect audit, catalog + native-family wiring.
- [x] Capability service + capability declaration (provenance parity).
- [x] CLI `rea antidote` command and `canonicalize_artifact` MCP registration.
- [x] CLI↔tool coverage alias.
- [x] Unit tests per normalizer; losslessness regression; service tests;
      MCP end-to-end; real-file provider test.
- [x] Docs: README section, MCP contracts entry, this spec.

## Tests

- `src/domain/canonicalize/canonicalize.test.ts` — per-normalizer fixtures
  (poisoned/inflated in, canonicalized facts out), the behavior-relevant
  losslessness regression (WASM core section ranges reproduce the original
  bytes), budget collapse, defensive truncation, and engine selection.
- `src/application/canonicalize/CanonicalizeService.test.ts` — input validation,
  Evidence assembly with a `file` subject, output identity cross-check, and
  late-cancellation retention (stub port).
- `src/canonicalize/CanonicalizeProvider.test.ts` — real-file end-to-end through
  the stable reader: canonicalizes a WASM module without mutating it, rejects a
  missing file, and refuses an input beyond the read budget.
- `tests/boundary/mcp/canonicalizeMcp.test.ts` — end-to-end through the MCP
  entry point: advertises the tool, drops non-semantic custom sections, and
  requires an absolute path.

## Verification notes

Verified under the pinned toolchain (Node 24.22.1):

- Typecheck: clean. `compile` (dist emit): clean.
- Canonicalize source tests — domain engine, application service, and the
  real-file provider end-to-end: pass.
- MCP end-to-end (`tests/boundary/mcp/canonicalizeMcp.test.ts`), CLI↔tool
  coverage (`tests/boundary/cli/cliToolCoverage.test.ts`), and the product
  catalog (`tests/boundary/filesystem/productCatalog.test.ts`): pass.
- Contract conformance (`advertisedInputExamples`, compact input/output schema
  budgets, `toolEffects`) and capability/family/provenance conformance
  (`capabilityDeclarations`, `mcpToolFamilies`, `targetContentProvenance`): pass.
- README consistency (`readmeConsistency`), `check-doc-facts`, and all generated
  `--check` passes (package/product/MCP-catalog/skill/cursor-plugin/completion/
  error-schema): pass. The catalogs are gitignored build outputs regenerated
  from source; nothing committed is stale.
- Lint: oxlint clean on the new files; `verify:module-boundaries` and the
  `REA_` numeric-limit guard pass (the feature adds no `REA_` setting).

Deferred to CI's environment:

- The complete multi-provider suite (`npm run check:pr`), which needs external
  providers (Ghidra, IDA, JADX, tshark, Frida, and the Windows native addon)
  not present in this dev environment. The built-test wrapper's Windows
  native-addon preflight does not apply on CI's Linux host.
