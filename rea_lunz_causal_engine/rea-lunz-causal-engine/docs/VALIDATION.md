# Validation Protocol

## Structural checks

- Graph schema version must match the engine format.
- Nodes and edges are size-limited and node identifiers must be unique.
- Every edge must use the closed relation vocabulary and point to existing nodes.
- Each edge requires at least one attached valid source identifier.
- Confidence and score fields must be finite values in `[0, 1]`.
- Edge confidence cannot exceed the quality score of its strongest attached source.

## Source checks

- HTTPS, approved hostname, no credentials, no nonstandard port, and no local/IP literal destination.
- Source type must be in the recognized provider vocabulary; source metadata and identifiers are size-bounded.
- Source excerpt has a bounded size and its SHA-256 must match the stored excerpt.
- Source identity is derived from normalized source identity fields.
- Exact package APIs require an exact entity-match flag.
- Search snippets and ordinary pages below the relevance floor are rejected.
- Reliability, match, freshness, and quality values must obey the derivation bound.
- Integration validation also requires byte-for-byte canonical equality with the process-local source ledger and an exact canonical graph snapshot captured at research time.

## Contradiction handling

Conflicting support and contradiction relationships for the same ordered node pair are retained and surfaced in validation warnings. The graph is labeled `conflicted`; evidence is not silently discarded to force a single conclusion.

## Local facts

A target fact is considered verified only when its REA Evidence identifier resolves and the exact stated value is present in that Evidence payload. Unverified facts remain explicitly marked; they cannot create candidate causal edges.

## Test commands

```bash
npm test
npm run check
```

The test suite includes allowlist and query-sanitization checks, injected network fixture tests, source-digest tampering, local-fact verification, malformed graph rejection, and simulation/visibility reporting.

## Operational policy

No heuristic validator can establish that an arbitrary causal claim is universally true from web pages alone. This engine's practical validation contract is narrower: it establishes data integrity, provenance, source policy, entity-match constraints, bounded confidence, graph integrity, and visible contradiction reporting. Behavioral causality remains a hypothesis until independently confirmed against the analyzed artifact.
