# JavaScript Application Graph

JavaScript Application Graph v1 is REA's provider-neutral domain model for
connecting shipped application bytes, JavaScript structure, Electron process
boundaries, passive browser observations, and native add-ons. It is a durable,
canonical data contract; it is not an extractor or a new CLI/MCP tool.

The implementation is pure and side-effect free. It validates caller-supplied
facts, derives semantic identifiers, enforces graph integrity, and serializes
verified graphs as RFC 8785 canonical JSON. It performs no filesystem or CDP
I/O, does not evaluate JavaScript, and has no application-specific node kinds.

## Layer boundary

The graph complements existing REA models instead of replacing them:

| Existing model               | Responsibility                                                                         | Application Graph use                                      |
| ---------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Artifact graph               | Content-addressed containers, byte occurrences, and extraction boundaries              | Supplies artifact identities and exact paths               |
| Web bundle analysis          | Bounded AST, chunk, route, endpoint, and source-map observations                       | Supplies static nodes and relationships                    |
| Browser/Electron observation | Authorized passive CDP metadata and runtime captures                                   | Supplies runtime instances and `observed_as` relationships |
| Native analysis              | Provider-qualified binary functions, symbols, and references                           | Supplies native add-on/export observations                 |
| JavaScript Application Graph | Cross-layer entity identity, evidence-bearing relationships, and canonical commitments | Preserves the combined application model                   |

The shipped [JavaScript artifact reconstruction](javascript-artifact-reconstruction.md)
service now projects bounded directory/ASAR, package, bundle, and source-map
facts into this graph. Electron IPC/security boundaries, passive runtime
reconciliation, and native-export projection remain separate later layers. The
domain module itself never reaches outward to obtain any of those facts.

## Versioned record

A stored graph has this top-level shape:

```text
schema: "JavaScriptApplicationGraph"
schema_version: 1
graph_id: jag_<sha256 of normalized graph semantics>
root_node_ids: jag_node_<sha256>[]
nodes: application entities with one or more observations
edges: directed evidence-bearing relationships
coverage: complete, partial, unknown, or unavailable
limitations: explicit graph-wide constraints
```

Parsing rejects unknown fields, unsupported versions, non-canonical ordering,
duplicate IDs, stale semantic commitments, missing roots, dangling endpoints,
self-edges, and `changed_from` edges between unlike node kinds. Constructors
normalize set-like arrays before deriving their IDs.

## Entities and relationships

The v1 node vocabulary covers:

- package, installer, and artifact;
- ASAR entry;
- Electron main, preload, renderer, and utility process code;
- JavaScript asset, chunk, and module;
- source map and original source module;
- BrowserWindow, frame, and target;
- contextBridge API, IPC channel, and IPC handler;
- worker and service worker;
- endpoint and storage;
- native add-on and native export;
- runtime script instance;
- an explicit `unknown` kind when classification is not justified.

The directed relation vocabulary is `contains`, `loads`, `imports`, `maps_to`,
`exposes`, `sends`, `invokes`, `handles`, `calls`, `persists_to`, `observed_as`,
and `changed_from`. Provider names are deliberately absent from both
vocabularies.

For example, a source-owned synthetic fixture proves this path without using a
third-party application:

```text
package contains app.asar
app.asar contains preload
preload exposes contextBridge API
contextBridge API invokes IPC channel
IPC channel handles main-process handler
handler loads native add-on and calls native export
native add-on contains native export
preload observed_as runtime script instance
```

The `invokes` and `calls` facts in that fixture remain static inferences. The
runtime correspondence is a separately identified passive observation.

## Evidence and authority

Every observation and edge carries all of the following:

- an authority, such as artifact bytes, AST analysis, static relationship
  inference, passive CDP runtime, controlled replay, native analysis,
  historical reference, or user assertion;
- an epistemic state: `observed`, `inferred`, `unknown`, or `unavailable`;
- confidence independently bounded as exact, high, medium, low, or unknown;
- an explicit content-addressed artifact reference or an unavailable reason;
- an explicit artifact, source, URL, runtime, native, or package-export
  location, or an unavailable reason;
- extractor name, version, operation, and optional executable digest;
- coverage status, truncation, omitted count, and named limits;
- limitations and links to existing Evidence v2 records;
- a content-derived identifier and its declared stability strategy.

Authority and epistemic state are separate fields. An AST observation does not
become a runtime fact, and a passive runtime fact does not prove which static
module produced it. In particular:

- `static-relationship-inference` can only produce `inferred` facts;
- unknown or unavailable facts require unknown confidence and a limitation;
- inferred facts require an explicit limitation;
- exact confidence is reserved for observations;
- all observations require an actionable location, and artifact-backed facts
  require a digest;
- static/native authorities cannot claim runtime locations;
- truncated coverage must be partial, name the limiting bound, and not claim
  zero omissions;
- complete coverage cannot be truncated or omit items.

Unavailable values are represented explicitly rather than as missing fields,
so absence of evidence cannot silently become evidence of absence.

## Entity identity

Nodes separate stable entity identity from individual observations. Changing a
label, extractor, or evidence record changes the observation ID without
necessarily changing the node ID.

| Strategy                  | Stability scope                  | Intended use                                                      |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `content-digest`          | Globally exact bytes             | Artifacts and byte-identical assets                               |
| `source-map-original`     | One source-map commitment        | Recovered original source modules                                 |
| `canonical-path`          | One artifact version             | ASAR entries and assets at exact normalized paths                 |
| `artifact-local-key`      | One artifact version             | IPC channels, handlers, exports, and other named entities         |
| `structural-fingerprint`  | Explicit cross-version inference | Modules whose relationship is hypothesized from bounded structure |
| `runtime-instance`        | One capture only                 | Targets, frames, and runtime scripts                              |
| `observation-fingerprint` | One observation scope            | Facts with no stronger justified identity                         |

Every strategy states its stability scope. Runtime identities commit the
capture digest and runtime key; canonical-path and artifact-local identities
commit the containing artifact digest. Structural fingerprints require an
inferred supporting observation and never claim exact cross-version identity.
Content-digest and source-map identities require an observation of the same
artifact digest.

Observation IDs use `semantic-content-sha256` with `observation-exact`
stability. Edge IDs use the same derivation with `relationship-exact`
stability. Node, observation, edge, and graph IDs are recomputed during parsing,
so callers cannot preserve a stale ID after changing semantic content.

## Bounds

The v1 boundary admits at most 1,000 roots, 100,000 nodes, 200,000 edges, and 64
observations per node. Each properties object is valid bounded JSON with at most
64 keys, depth 6, 512 structural nodes, and 4,096 characters per string. Arrays
of evidence links, limits, and limitations have independent caps.

These are admission limits, not completeness claims. When an extractor reaches
a limit, it must record partial coverage and the exact named limit. It must not
return a bounded prefix labeled complete.

## Domain API

The public domain functions are:

- `createJavaScriptApplicationNode` to normalize an entity and derive node and
  observation IDs;
- `createJavaScriptApplicationEdge` to normalize a relationship and derive its
  ID;
- `createJavaScriptApplicationGraph` to sort complete graph content and derive
  its graph ID;
- `parseJavaScriptApplicationGraph` to verify a stored graph and every
  commitment;
- `serializeJavaScriptApplicationGraph` for canonical JSON;
- `computeJavaScriptApplicationGraphSha256` for a byte-stable verified graph
  digest.

Schema evolution is explicit. A future incompatible shape receives a new
`schema_version`; v1 parsing fails with an unsupported-version diagnostic rather
than guessing how to reinterpret it.
