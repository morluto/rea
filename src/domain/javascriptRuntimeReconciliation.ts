import { classifyStaticLoadStates } from "./javascriptRuntimeLoadState.js";
import { buildReconciledApplicationGraph } from "./javascriptRuntimeReconciliationGraph.js";
import { reconcileRuntimeEntities } from "./javascriptRuntimeReconciliationMatching.js";
import {
  parseRuntimeCaptures,
  parseStaticLayers,
} from "./javascriptRuntimeReconciliationParsing.js";
import { createJavaScriptRuntimeReconciliationResult } from "./javascriptRuntimeReconciliationResult.js";
import type { JavaScriptRuntimeReconciliationResult } from "./javascriptRuntimeReconciliationSchemas.js";
import { reconcileJavaScriptRuntimeInputSchema } from "./javascriptRuntimeReconciliationSchemas.js";
import { projectRuntimeCaptures } from "./javascriptRuntimeReconciliationRuntime.js";
import { collectStaticRuntimeCandidates } from "./javascriptRuntimeStaticCandidates.js";

/** Reconcile static JAG layers with authorized passive CDP Evidence. */
export const reconcileJavaScriptRuntime = (
  input: unknown,
): JavaScriptRuntimeReconciliationResult => {
  const parsed = reconcileJavaScriptRuntimeInputSchema.parse(input);
  const layers = parseStaticLayers(parsed.static_layers);
  const captures = parseRuntimeCaptures(parsed.runtime_observations);
  const runtime = projectRuntimeCaptures(
    captures,
    parsed.limits.max_runtime_entities,
  );
  const candidates = collectStaticRuntimeCandidates(layers);
  const matching = reconcileRuntimeEntities({
    entities: runtime.entities,
    candidates,
    layers,
    maximumItems: parsed.limits.max_reconciliation_items,
  });
  const loadStates = classifyStaticLoadStates(
    layers,
    runtime.entities,
    matching.items,
    {
      maximumStates: parsed.limits.max_static_load_states,
      reconciliationComplete:
        runtime.omittedEntities === 0 && matching.omittedItems === 0,
    },
  );
  const graph = buildReconciledApplicationGraph({
    layers,
    captures,
    runtime,
    reconciliationEdges: matching.edges,
    omittedReconciliationItems: matching.omittedItems,
  });
  return createJavaScriptRuntimeReconciliationResult({
    layers,
    captures,
    runtime,
    matching,
    loadStates,
    graph: graph.graph,
    omittedGraphItems: graph.omittedGraphItems,
  });
};
