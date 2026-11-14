# Separate RPC operations that share one POST path

## Outcome

Many web applications send unrelated reads and writes through one `POST` path: GraphQL (`operationName`), JSON-RPC
2.0 and MCP (`method`), and Google `batchexecute` (`f.req` or a single `rpcids`). The manifest grouped exchanges by
method and path template only, so every operation on such a path became one tool and one state bucket, and
`batchexecute` responses guarded with `)]}'` were dropped as non-JSON.

Operations on a shared `POST` path now become separate tools, state buckets and replay targets, and guarded JSON
responses are read consistently.

## Requirements

- An operation name is read from the recorded request body (and, for `batchexecute`, the query string, also when
  `include_query_parameter_names` is false). Names are 1 to 128 characters; bodies over 64 KiB of UTF-8 and query
  strings over 8 KiB are not read. Ambiguous batches and malformed bodies name no operation.
- Tools are split by operation only when two or more operations share the method, origin and an equal or overlapping
  path template. A path with one operation keeps its plain tool name; a later capture that adds a second operation
  splits the names. Split tools carry `rpc_operation: { kind, name }` and append the operation words to the name.
- Path-segment templating (`{param}`) still applies within one operation.
- State keeps read-like and write-like operations in separate buckets. A GraphQL document's top-level definition
  decides (fragments skipped); a declared `mutation` or `subscription` stays a write whatever its response repeats.
- `)]}'`-guarded and length-framed JSON responses within 64 KiB (256 KiB on JSON-like media types) count as JSON for
  manifest eligibility, state, replay and comparison.
- Replay and comparison select the operation from the same bounded raw request text and dispatch only to that
  operation's tool on a split path; an unrecorded operation there is refused rather than sent to a sibling.
- Saved bundles made before `rpc_operation` existed derive the same state and confirmed writes as before.

## Non-goals

- Splitting multi-operation JSON-RPC batch arrays or multi-ID `batchexecute` envelopes.
- Inferring operations from response bodies.

## Acceptance

- Unit: operation selection for each protocol, limits, fallbacks, and guarded response parsing.
- Domain: split and unsplit tool names, sibling templating, query-only `batchexecute` separation, read and write
  buckets, declared mutations staying writes.
- Application: pre-RPC bundle compatibility, tool input schemas, replay dispatch and refusal, and live comparison.
