# REA Lunz External Evidence Engine

An evidence-first research and graph engine designed for REA's MCP server. It retrieves external technical facts, constructs a typed graph deterministically, validates source provenance and graph integrity, preserves contradictions, and generates code visibility and reconstruction-fidelity reports.

## Integration

Requirements: Node.js `^22.19.0`, `^24.11.0`, or `>=26.0.0`, and a checkout of the `morluto/rea` repository.

From this package directory:

```bash
node scripts/install-rea-integration.mjs /absolute/path/to/rea
node scripts/verify-rea-integration.mjs /absolute/path/to/rea
```

Build the REA project using its existing workflow:

```bash
cd /absolute/path/to/rea
npm run build:cached
npm run test:run
```

The installer adds a new engine module, three MCP contracts, a registrar, and the build-copy step. It patches REA's canonical tool contract list, effect audit, and central server composition. It refuses to overwrite existing destination files by default. Review any existing destination before choosing `--force`.

## MCP tools

- `investigate_external_evidence_graph`: bounded web search, package registry metadata, dependency metadata, vulnerability advisories, typed graph construction, confidence scoring, and a quality summary.
- `validate_external_evidence_graph`: strict verification of source URLs, content digests, source identities, current-engine provenance, relationship types, endpoints, evidence references, confidence bounds, and contradictory claims.
- `generate_code_fidelity_report`: per-part visibility, simulation/inference, confidence ranking, and likely divergence from the original implementation.

## Standalone tests

```bash
npm test
npm run check
```

## Research controls

Only HTTPS destinations on the allowlist are accepted. Redirects are rejected. Fetch time, response size, concurrency, query size, source count, package count, and evidence excerpt length are bounded. Source code literals are removed from web query terms; raw target source is not submitted to the search provider. Source content is stored with a digest. Package metadata is matched to the exact requested package and version where available. A local fact is linked to an external result only when its supplied REA Evidence identifier resolves and the stated fact is present in that Evidence record.

## Graph semantics

Edges describe sourced support, contradiction, package declarations, affected versions, and candidate causal relationships. `candidate_causal_link` never represents proven causality. Independent-domain corroboration uses a capped noisy-OR score. Edge confidence is bounded by the strength of its attached sources. Scores are evidence-ranking signals, not calibrated probabilities.

## Fidelity reporting

The report separates observable original source, runtime observation, static analysis, decompilation, pseudocode, generated code, metadata, stubs, and unknown regions. It records completeness, limitations, suspected mismatches, simulation indicators, and evidence references. A high score does not prove equivalence; missing observations are not counted as verified behavior.

## Repository layout

```text
src/external-evidence-engine/
  index.mjs
  index.d.mts
  security.mjs
  validation.mjs
  fidelity-report.mjs
integration/rea/src/
  contracts/externalEvidenceToolContracts.ts
  server/registerExternalEvidenceGraphTools.ts
scripts/
  install-rea-integration.mjs
  verify-rea-integration.mjs
  copy-external-evidence-engine.mjs
tests/
  engine.test.mjs
  validation.test.mjs
  fidelity-report.test.mjs
docs/
  ARCHITECTURE.md
  VALIDATION.md
```
