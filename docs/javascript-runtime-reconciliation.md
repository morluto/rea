# JavaScript static/runtime reconciliation

REA can combine an existing static JavaScript Application Graph with one or
more passive browser or Electron captures without collapsing their different
authorities. The `reconcile_javascript_runtime` MCP tool and
`rea reconcile-javascript-runtime` CLI command accept Evidence v2 records and
return derived Evidence v2 containing a combined JavaScript Application Graph
and explicit match, ambiguity, mismatch, and unknown classifications.

The operation performs no filesystem, browser, or Electron I/O. It accepts only
semantically verified Evidence produced by `analyze_javascript_application`,
`inspect_web_page`, or `inspect_electron_page`; matching operation names alone
is insufficient. Provider identity, predicate version, subject digest, target
parameters, and normalized-result schemas are checked before reconciliation.

## Workflow

1. Run `analyze_javascript_application` against exactly one application layer.
   Optional cache or assets directories can be analyzed independently and
   supplied as additional layers.
2. Run `inspect_web_page` or `inspect_electron_page`. Capturing script sources
   is optional, but an approved source capture provides the strongest byte
   identity.
3. Pass the resulting Evidence records to `reconcile_javascript_runtime`.
   Browser URLs normally need an explicit URL-prefix mapping. Extracted
   Electron directories are mapped automatically when runtime files remain
   beneath the analyzed input root; relocated files, ASAR projections, caches,
   and asset roots need explicit mappings.

The MCP input has this shape; the `analysis` and `runtime_observations` values
are complete Evidence v2 objects, not only evidence IDs:

```json
{
  "static_layers": [
    {
      "role": "application",
      "analysis": "ANALYZE_JAVASCRIPT_APPLICATION_EVIDENCE",
      "runtime_mappings": [
        {
          "kind": "url-prefix",
          "prefix": "https://example.test/assets/",
          "artifact_prefix": "dist"
        }
      ]
    }
  ],
  "runtime_observations": ["INSPECT_WEB_PAGE_EVIDENCE"],
  "limits": {
    "max_runtime_entities": 10000,
    "max_reconciliation_items": 20000,
    "max_static_load_states": 20000
  }
}
```

`static_layers` requires exactly one `application` role and permits additional
`cache` and `assets` roles. A `file-root` mapping translates a canonical runtime
filesystem root to an artifact-relative prefix. A `url-prefix` mapping does the
same for one exact HTTP(S) origin and path prefix. Mappings cannot add CDP
origins, broaden Electron roots, read files, or authorize source-map access;
they are caller-declared inference inputs applied only to already-authorized
locations.

The one-shot CLI accepts either a JSON file path or the same JSON inline. A
file avoids the operating system's command-line size limit for realistic
Evidence records:

```bash
rea reconcile-javascript-runtime reconciliation-input.json --json
```

For a repeatable local check from operator-provided paths, build first and run:

```bash
npm run verify:javascript-runtime -- \
  --application /absolute/path/to/app \
  --cache /absolute/path/to/cache \
  --runtime-evidence /absolute/path/to/electron-evidence.json \
  --mapping '{"layer":1,"kind":"file-root","root":"/runtime/cache","artifact_prefix":""}'
```

The verifier analyzes the supplied static paths under a temporary in-process
permission policy, reads bounded Evidence JSON files, and prints graph IDs,
evidence IDs, paths, digests, counts, reasons, and coverage. It does not print
captured source text. `--source-map-read-approved` remains a distinct explicit
approval.

## Matching rules

Runtime targets, frames, scripts, and workers become capture-scoped graph
nodes. REA evaluates compatible static candidates conservatively:

1. An approved captured-source SHA-256 plus one matching mapped location yields
   a content-and-location match.
2. One unique exact content digest can match even when no location mapping is
   available. Whole-asset digests and reconstructed module-factory source
   digests remain distinguishable in the reported basis.
3. Without captured bytes, one unique mapped artifact path can produce a
   medium-confidence location match.
4. Multiple candidates remain `ambiguous`; no `observed_as` edge is emitted.
   `candidate_static_count` reports the full qualified layer/node count while
   `candidate_static_nodes` retains a deterministic bounded prefix.
5. If captured bytes disagree with the static candidate at the mapped path,
   the result is an explicit mismatch. A path never overrides a digest
   disagreement.
6. Missing authorization mappings, incomplete input coverage, and output
   limits remain unknown or truncated rather than becoming absence claims.

Every successful cross-layer `observed_as` edge has
`authority: cross-layer-reconciliation` and `state: inferred`. The underlying
artifact/AST observations and passive-CDP observations remain unchanged and
retain their own Evidence links.

## Loaded, resident, and not observed

Static JavaScript assets, chunks, and modules receive a separate load-state
classification:

- `loaded` means an accepted runtime script correspondence was found, using
  exact bytes or one unique mapped location;
- `resident-in-loaded-asset` means a containing asset was observed, but the
  embedded module was not independently observed or shown to execute;
- `not-observed-in-capture` means the entity did not appear in the complete
  bounded captures supplied to this call and its artifact path falls beneath
  an exercised automatic or operator-declared mapping prefix;
- `unknown` covers incomplete captures, layers outside runtime scope, and
  unresolved correspondence. Nodes outside a mapped artifact prefix stay
  unknown even when another prefix in the same static layer was observed.

None of these states proves feature execution, initialization order,
reachability, or causality. In particular, `not-observed-in-capture` never means
globally unloaded.

## Frames, workers, and source maps

Passive inspection now retains the execution-context frame ID supplied by CDP
for each accepted script. Electron captures also inventory authorized worker,
service-worker, and shared-worker targets, including bounded opener-target and
parent-frame relationships. These fields improve attribution while preserving
the original exact-origin or canonical-root filter.

Source-map declarations and approved original-source reads stay under static
source-map authority. They are reported in `source_map_authority` but never used
as primary runtime byte matches. A source name or `sourcesContent` digest is not
silently equated with the generated bytes observed by CDP.

## Bounds and determinism

Inputs allow up to eight static layers and 32 passive captures. Default output
bounds retain 10,000 runtime entities, 20,000 reconciliation records, and
20,000 static load states; each caller-visible maximum is 50,000. At least one
target node per capture must fit. The combined graph also preserves the JAG v1
caps of 1,000 roots, 100,000 nodes, 200,000 edges, and 64 observations per
node. Reaching a limit reports exact omitted counts for runtime entities,
reconciliation items, static load states, and merged graph items, plus
`coverage.status: truncated`.

Layers, captures, nodes, edges, matches, and evidence links are canonically
ordered. Repeating the same verified Evidence, mappings, and limits produces
the same reconciliation, graph, and Evidence identifiers.

## Non-goals

Reconciliation does not attach to CDP, fetch scripts or source maps, execute
JavaScript, invoke Electron IPC, inspect native add-ons, infer arbitrary URL
rewrites, or search the filesystem. It does not replace the older
`correlate_static_and_runtime` investigation tool: that tool records explicit
cross-version static/runtime comparison hypotheses, while this operation maps
JavaScript runtime instances to static application-graph entities.
