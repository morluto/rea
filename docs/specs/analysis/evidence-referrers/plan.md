# Implementation plan

Extend the existing link-delivery input and output contracts with an optional
`linked_evidence_id`. Keep source selectors in `filters` unchanged. The shared
application inspection owner rejects link-only fields on other deliveries.

`inspectEvidenceLinks` remains the sole interpreter of retained link membership.
It selects source records and traverses outgoing links as before, then filters
direct rows by the selected target before counting and paging them. Track
missing outgoing links independently so filtering rows cannot strengthen the
existing closure claim. Read metadata and explicit links only, without copying
payloads or creating a persistent reverse index.

Both MCP session inspection and CLI file inspection already call this owner.
Forward the selector through both paths, document the conditional status
default, and exercise public adapters plus existing advertised-schema checks.
No provider or execution-authority boundary changes.

## Verification

Completed on 2026-11-16:

- `npm run test:focused -- tests/boundary/cli/analysisViewCli.test.ts tests/boundary/mcp/evidenceLinkInspectionMcp.test.ts`:
  all 42 tests passed (33 CLI, 9 MCP), including existing outgoing queries and the
  new target selection, source filtering, paging, missing-target, import and
  reset cases. MCP exercised output advertisements off and compact, as well as
  the complete canonical output schema.
- A compiled stdio MCP smoke imported a bundle, found one target referrer, reset
  the investigation, and found zero referrers.
- `npm run docs:check`: generated-document consistency and all eight README
  consistency tests passed.
- `npm run check:fast`, `npm run knip:production`, and
  `npm run verify:test-discovery` passed.
- `node scripts/verify-advertised-schemas.mjs --complete --update-summary`:
  all configured schema engines passed validation of 31 patterns and 252
  distinct schemas across four catalogs. Only the `get_evidence_bundle` schema
  summary changed.

`npm run check` remains blocked by repository-wide `knip` findings: one unused
file, five unused exports, two unused exported types, and one duplicate export.
An independently built, uncached `knip` run on base commit
`a10037ef10516cf92653596512932b15f190a5c0` reported the same findings, all outside
the changed files. This does not count as a passing complete `check` gate.

An additional full `npm run lint:typed` run reported four exhaustiveness errors
in unchanged JSON-token, browser CDP and V8-inspector files. Focused typed-lint
runs on those same four files in the unmodified base reproduced every error;
none was reported in the files changed here.

The feature reads retained metadata only. No real analysis-provider runtime or
performance benchmark was exercised or claimed.
