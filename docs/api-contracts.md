# Offline API contract inventory

`inspect_api_contract` / `rea inspect-api-contract` reads one local OpenAPI
3.0, 3.1 or 3.2 JSON document. It inventories inline operation slots under
`paths`; the facts describe declarations, not implemented, reachable or
authorized runtime behavior. YAML, AsyncAPI, callbacks/webhooks, schema graphs,
contract diffs and traffic correlation are outside this version.

The importer never resolves references, opens sibling documents, evaluates
examples or contacts declared servers. OpenAPI 3.2 `query` and
`additionalOperations` follow the [Path Item contract](https://spec.openapis.org/oas/v3.2.1.html#path-item-object),
including case-sensitive additional HTTP method spelling.

## Select a useful answer

MCP defaults to a summary retaining the complete inventory. An optional view
returns selected facts immediately, taking precedence over `detail`:

```json
{
  "path": "/artifacts/openapi.json",
  "view": {
    "kind": "api-contract",
    "collection": "operations",
    "methods": ["GET"],
    "limit": 20
  }
}
```

`operations` supports exact `operation_ids`, `operation_keys`, `methods`,
`paths`, `declared_ids` and `states` filters. Filters combine by intersection;
empty arrays select nothing. `fields` chooses columns; identity, source pointer,
state and unknown reason remain. The other collections are
`path-item-references` (optional `reference_ids`) and `diagnostics` (optional
`codes`), also with fields and offset/limit. The default page contains 64 rows.

Query a retained result with `inspect_analysis_view`, using the same view and
`source: {"kind":"retained-evidence","evidence_id":"..."}`. Copy the complete
parent ID from `normalized_result.parent_evidence_id`, not the summary's own ID.
These pages use immutable retained facts without rereading the specification.
Complete Evidence remains available through `get_evidence_bundle`.

CLI defaults to complete Evidence. For a selected answer, save that complete
Evidence in an absent bundle path:

```sh
rea inspect-api-contract ./openapi.json --detail summary \
  --view '{"kind":"api-contract","collection":"operations","methods":["GET"],"limit":20}' \
  --evidence_output ./contract.evidence.json --json
```

Later `rea inspect-analysis-view` can read that bundle through an exact
`evidence-file` source selection, even after the original specification is
unavailable. Publication never overwrites an existing file. CLI preserves its
original path spelling in `caller_input_path`; analysis locations and MCP inputs
use absolute filesystem paths.

## Identity, provenance and coverage

Each operation has an artifact-scoped `operation_id`, an exact method/path
`operation_key`, an optional `declared_id` from `operationId`, and its original
JSON Pointer. Keys can correlate exact declarations in a caller-selected pair
of revisions; they do not establish equivalence across unrelated APIs, renamed
path templates or runtime handlers. Declared IDs are not assumed unique.
The artifact includes the verified byte length, SHA-256 and selected path.

Malformed siblings retain useful declarations plus diagnostics. A Path Item
`$ref`, including a local fragment, remains unresolved; adjacent inline slots
are unknown because referenced fields may overlap. Missing or malformed paths
are explicit, and missing required OpenAPI 3.0 paths does not become a complete
empty inventory. `source_coverage` is limited to inline paths and records that
reference resolution and full schema validation were not performed. Page
exhaustion describes the selected rows and never upgrades source coverage.

Structured transport userinfo credentials are excluded from reference URIs;
`credential_redacted` reports that change, and an ambiguous credential span leaves
the displayed reference unknown. Ordinary reference query/fragment text and
names are retained. Original bytes remain in the caller's artifact; complete
inventory Evidence does not embed the entire source JSON. Duplicate JSON members
use the shared parser's last-value-wins behavior, recorded in source coverage.

If decoding or later validation fails after a verified read, the typed error
retains a compact `file-snapshot-hash` observation with the exact path, digest
and byte length. Syntax diagnostics do not quote source JSON. Cancellation
does not replace a parser failure that has already completed.

## Resource bounds and verification

The file-byte allowance and conservative expanded-facts allowance are each
32 MiB resource policies, not OpenAPI format limits. `max_file_bytes` can lower
the input allowance. Native JSON parsing additionally checks available heap
against the shared representation-expansion estimate before decoding. The
shared JSON nesting limit is 1,000, including uninterpreted schema regions.
Capacity refusals are typed; reply paging does not increase parser allowances.

The committed [Petstore fixture](https://github.com/morluto/rea/blob/b7c8caedd4166e6032c49024cdc6fb1154f1a2df/tests/fixtures/openapi/README.md) is an
original document from the published application, replayed offline through
public CLI/MCP tests. These check advertised schemas, complete/selected parity,
retained paging, partial references, zero requests to a loopback reference
server and unchanged source bytes. They do not establish runtime endpoint
behavior or full OpenAPI conformance.
