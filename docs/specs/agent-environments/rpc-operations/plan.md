# Implementation plan

1. **Selector.** `src/domain/analysisView/rpcOperationSelector.ts` reads a bounded operation name for GraphQL,
   JSON-RPC and `batchexecute`, and detects and parses guarded JSON responses without backtracking patterns.
2. **Manifest.** `EnvironmentManifestAccumulator` admits the operation and guarded-JSON facts while preparing a
   record and writes them in its commit step; the grouping key, sibling rules and names include the operation only
   for overlapping groups.
3. **State.** The state accumulator, rules and query-call classification carry `rpc_operation`; GraphQL documents are
   scanned for their top-level definition, and declared mutations or subscriptions never become reads. Bundles
   without `rpc_operation` take the undiscriminated path.
4. **Replay and comparison.** `matchReplayTool` selects the operation from the raw request text across fitting
   templates and is shared by serving and comparison; tool descriptions name the operation.
5. **Docs and tests.** Web network capture and agent environment guides, with unit, domain and application tests.
