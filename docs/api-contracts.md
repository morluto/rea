# Offline API contract inventory

`inspect_api_contract` / `rea inspect-api-contract` supports local OpenAPI JSON
(`format: "openapi-json"`, the default), OpenAPI YAML (`format: "openapi-yaml"`)
and GraphQL SDL (`format: "graphql-sdl"`). No profile contacts endpoints.

## OpenAPI JSON

The default profile reads one local OpenAPI
3.0, 3.1 or 3.2 JSON document; `openapi-yaml` reads the same declarations from
the equivalent YAML document. Both inventory inline operation slots under
`paths`; the facts describe declarations, not implemented, reachable or
authorized runtime behavior. AsyncAPI, callbacks/webhooks, schema graphs,
contract diffs and traffic correlation are outside this version.

YAML is composed into the same JSON-compatible shape before inventory, so
anchors, aliases, tags and comments change nothing in the reported facts.
Unlike JSON, a repeated mapping key is rejected instead of resolving
last-value-wins: YAML composition cannot express which declaration the author
meant. `source_coverage.duplicate_json_members` records `last-value-wins` for
JSON and `rejected` for YAML.

The OpenAPI importer never resolves references, opens sibling documents, evaluates
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

## GraphQL SDL and operation documents

Select `format: "graphql-sdl"` for SDL. Optionally supply `operations_path` to
one local document containing operations and fragments. Both MCP paths are
absolute; CLI accepts relative spellings:

```sh
rea inspect-api-contract ./schema.graphql --contractFormat graphql-sdl \
  --operationsPath ./queries.graphql --detail summary \
  --view '{"kind":"graphql-contract","collection":"references","limit":20}' \
  --evidence_output ./graphql.evidence.json --json
```

Collections are `types`, `fields`, `definitions`, `references`, `fragment-spreads`
and `diagnostics`. Each supports `fields`, `offset` and `limit` (default 64).
Exact batch filters include type/field/definition/reference IDs, type names,
`field_keys` such as `Query.viewer`, owning type names, binding/spread states
and diagnostic codes. Filters intersect; an empty array selects nothing.
Identity, source and applicable uncertainty fields always remain. Retained pages
and bundle-based queries use the same `graphql-contract` views without rereading
SDL or rebuilding its schema model.

Types and fields retain individual declaration occurrences, including extensions,
list/non-null wrappers, implemented interfaces and union member names. Operation
and fragment definitions own field references with aliases and parent-reference
IDs. Each reference links to a supplied SDL field occurrence, remains `model-only`
for a library-provided field such as `__typename`, or records an exact unknown
reason. Rejected schema construction keeps declarations but cannot supply trusted
bindings. Missing or duplicate fragment names remain explicit. Fragments are
visited once in their declared type scope and linked by spread edges; cycles
are never recursively expanded.

The versioned `graphql-sdl-field-bindings-v1` profile records the GraphQL library
version. It performs syntax parsing and schema construction for field resolution;
it does not establish whole-schema/operation validity, spread applicability,
reachability, authorization or endpoint behavior. Arguments, defaults,
descriptions, directive behavior, enum value inventory, introspection JSON,
federation composition and version comparison remain outside this profile.

Every fact has a document role, SHA-256, UTF-16 start/end offsets and parser token
line/column. Offsets address decoded UTF-8 text, including an optional BOM, rather
than byte positions. The two files are independently verified snapshots, not an
atomic pair. Fact IDs identify source occurrences; `field_key` separately supports
exact name-based joins and does not assert equivalence across revisions. CLI
retains its auxiliary path spelling in `caller_input_paths.operations_path`,
outside semantic identity, as well as its primary `caller_input_path`.

Malformed operation text retains the SDL inventory with partial coverage and a
source-located diagnostic. A primary parser refusal or later resource/cancellation
failure retains known source identities and available interpreted Evidence;
syntax diagnostics do not quote source text. Complete Evidence contains facts,
not original document bytes. An exhausted page never upgrades source coverage.

Each file has the same configurable maximum of 32 MiB. Conservatively charged
facts share a 32 MiB allowance; text/AST allocation is admitted against available
heap. The parser admits at most 262,144 lexical tokens and 65,536 comments per
document; subsequent iterative AST admission limits traversal depth to 128.
These are REA resource policies, not GraphQL language limits. Very deep input can
be refused by the parser before AST admission. Selected replies reduce transport
and retained queries reuse immutable facts; they do not avoid the initial parse.

The committed SWAPI SDL is an unchanged public application fixture with provenance
in `tests/fixtures/graphql/README.md`. It supplies 53 types and 243 fields;
verification does not execute its API.

Large complete inventories can exceed the default MCP response budget even when
selected pages fit. Use `export_evidence_bundle` with a caller-selected local
path for complete retained Evidence, or CLI complete JSON/bundle publication.
A transport refusal does not erase a completed retained analysis. Narrow pages
and source coverage remain available on the same continuing connection.
