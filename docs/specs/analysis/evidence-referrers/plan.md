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

## Real-provider handoff verification

A local integration build also exercised the compiled stdio MCP server with
actual JADX headless MCP 0.7.1 and OpenJDK 21. The selected JAR matched SHA-256
`6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.
Two self-authored APKs were compiled with aapt into binary Android manifests.
Both real inspections retained complete source Evidence; a companion Android
declaration comparison linked those exact sources. For each source, the new
target selector returned the retained comparison as a direct referrer, both
without source filters and with the comparison operation selected.

The complete five-record session bundle was exported. The compiled CLI reused
that same bundle and returned the same referrer rows as MCP for both source
IDs. All eight MCP calls and three CLI parity commands passed canonical and
advertised schema checks and result assertions. The standalone query semantics
do not depend on an Android provider or the companion comparison operation.

The samples use `hasCode=false` and contain no DEX. This establishes a real
static-provider handoff into retained-link inspection for those samples, without
APK installation, target execution or business-code/runtime coverage. The query
itself reads retained metadata only. No performance improvement is claimed.
