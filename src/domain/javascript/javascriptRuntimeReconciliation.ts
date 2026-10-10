import { classifyStaticLoadStates } from "./javascriptRuntimeLoadState.js";
import { buildReconciledApplicationGraph } from "./javascriptRuntimeReconciliationGraph.js";
import { reconcileRuntimeEntities } from "./javascriptRuntimeReconciliationMatching.js";
import {
  parseStaticLayers,
  type ParsedStaticLayer,
} from "./javascriptRuntimeReconciliationParsing.js";
import {
  parseRuntimeCaptures,
  type ParsedRuntimeCapture,
} from "./javascriptRuntimeReconciliationCaptureParsing.js";
import { createJavaScriptRuntimeReconciliationResult } from "./javascriptRuntimeReconciliationResult.js";
import type { JavaScriptRuntimeReconciliationResult } from "./javascriptRuntimeReconciliationSchemas.js";
import type { ReconcileJavaScriptRuntimeInput } from "./javascriptRuntimeReconciliationSchemas.js";
import { projectRuntimeCaptures } from "./javascriptRuntimeReconciliationRuntime.js";
import { collectStaticRuntimeCandidates } from "./javascriptRuntimeStaticCandidates.js";

/** Verified caller input and the static and runtime facts parsed from it. */
export interface ParsedRuntimeReconciliationInput {
  readonly input: ReconcileJavaScriptRuntimeInput;
  readonly layers: readonly ParsedStaticLayer[];
  readonly captures: readonly ParsedRuntimeCapture[];
}

/** Parse caller Evidence once into the owner consumed by reconciliation. */
export const parseRuntimeReconciliationInput = (
  input: ReconcileJavaScriptRuntimeInput,
): ParsedRuntimeReconciliationInput => ({
  input,
  layers: parseStaticLayers(input.static_layers, ["static_layers"]),
  captures: parseRuntimeCaptures(input.runtime_observations, [
    "runtime_observations",
  ]),
});

/** Reconcile static JAG layers with authorized passive CDP Evidence. */
export const reconcileJavaScriptRuntime = (
  parsed: ParsedRuntimeReconciliationInput,
): JavaScriptRuntimeReconciliationResult => {
  const { layers, captures } = parsed;
  const runtime = projectRuntimeCaptures(captures);
  const candidates = collectStaticRuntimeCandidates(layers);
  const matching = reconcileRuntimeEntities({
    entities: runtime.entities,
    candidates,
    layers,
  });
  const loadStates = classifyStaticLoadStates(
    layers,
    runtime.entities,
    matching.items,
    {
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
