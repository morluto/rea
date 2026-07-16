import {
  compareCodePoints,
  type ApplicationNode,
} from "./javascriptApplicationGraph.js";
import type { ParsedStaticLayer } from "./javascriptRuntimeReconciliationParsing.js";
import type {
  JavaScriptRuntimeReconciliationItem,
  JavaScriptStaticLoadState,
} from "./javascriptRuntimeReconciliationSchemas.js";
import type { RuntimeReconciliationEntity } from "./javascriptRuntimeReconciliationRuntime.js";
import {
  createStaticRuntimeScope,
  mappedRuntimePaths,
  staticNodeWithinRuntimeScope,
} from "./javascriptRuntimeStaticCandidates.js";

export interface StaticLoadStateProjection {
  readonly states: readonly JavaScriptStaticLoadState[];
  readonly omittedStates: number;
}

/** Classify static code presence without claiming bundled module execution. */
export const classifyStaticLoadStates = (
  layers: readonly ParsedStaticLayer[],
  runtimeEntities: readonly RuntimeReconciliationEntity[],
  matches: readonly JavaScriptRuntimeReconciliationItem[],
  options: {
    readonly maximumStates: number;
    readonly reconciliationComplete: boolean;
  },
): StaticLoadStateProjection => {
  const states: JavaScriptStaticLoadState[] = [];
  let totalStates = 0;
  for (const layer of layers) {
    const projection = classifyLayer(layer, runtimeEntities, matches, {
      reconciliationComplete: options.reconciliationComplete,
      maximumStates: Math.max(0, options.maximumStates - states.length),
    });
    totalStates += projection.total;
    states.push(...projection.states);
  }
  return { states, omittedStates: totalStates - states.length };
};

const classifyLayer = (
  layer: ParsedStaticLayer,
  runtimeEntities: readonly RuntimeReconciliationEntity[],
  matches: readonly JavaScriptRuntimeReconciliationItem[],
  options: {
    readonly reconciliationComplete: boolean;
    readonly maximumStates: number;
  },
): { readonly states: JavaScriptStaticLoadState[]; readonly total: number } => {
  const nodes = layer.graph.nodes.filter(isLoadStateNode);
  if (options.maximumStates === 0) return { states: [], total: nodes.length };
  const direct = new Map<string, string[]>();
  for (const match of matches)
    if (
      match.status === "matched" &&
      match.static_layer_id === layer.layerId &&
      match.static_node_id !== null
    )
      append(direct, match.static_node_id, match.runtime_node_id);
  const resident = residentNodes(layer, new Set(direct.keys()));
  const runtimeScope = createStaticRuntimeScope(layer, runtimeEntities);
  const scopedEntities = runtimeEntities.filter(
    (entity) => mappedRuntimePaths(layer, entity).length > 0,
  );
  const layerComplete =
    options.reconciliationComplete &&
    layer.graph.coverage.status === "complete" &&
    scopedEntities.length > 0 &&
    scopedEntities.every(({ capture }) =>
      captureScriptsComplete(capture.evidence.evidence_id, runtimeEntities),
    );
  const states = nodes.slice(0, options.maximumStates).map((node) => {
    const runtimeNodeIds = uniqueSorted(direct.get(node.node_id) ?? []);
    if (runtimeNodeIds.length > 0)
      return state(layer, node, {
        status: "loaded",
        runtimeNodeIds,
        reason: "runtime-script-correspondence",
      });
    if (resident.has(node.node_id))
      return state(layer, node, {
        status: "resident-in-loaded-asset",
        runtimeNodeIds: [],
        reason: "containing-asset-was-loaded",
      });
    const nodeWithinScope = staticNodeWithinRuntimeScope(node, runtimeScope);
    if (layerComplete && nodeWithinScope)
      return state(layer, node, {
        status: "not-observed-in-capture",
        runtimeNodeIds: [],
        reason: "not-observed-in-bounded-capture",
      });
    return state(layer, node, {
      status: "unknown",
      runtimeNodeIds: [],
      reason: !nodeWithinScope
        ? "layer-outside-runtime-scope"
        : "static-or-runtime-coverage-incomplete",
    });
  });
  return { states, total: nodes.length };
};

const residentNodes = (
  layer: ParsedStaticLayer,
  directlyLoaded: ReadonlySet<string>,
): ReadonlySet<string> => {
  const nodeKinds = new Map(
    layer.graph.nodes.map(({ node_id: id, kind }) => [id, kind]),
  );
  const children = new Map<string, string[]>();
  for (const edge of layer.graph.edges)
    if (edge.relation === "contains")
      append(children, edge.source_node_id, edge.target_node_id);
  const pending = [...directlyLoaded].filter(
    (nodeId) => nodeKinds.get(nodeId) === "javascript-asset",
  );
  const resident = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current === undefined) break;
    for (const child of children.get(current) ?? []) {
      if (resident.has(child)) continue;
      resident.add(child);
      pending.push(child);
    }
  }
  return resident;
};

const append = (
  values: Map<string, string[]>,
  key: string,
  value: string,
): void => {
  const current = values.get(key);
  if (current === undefined) values.set(key, [value]);
  else current.push(value);
};

const captureScriptsComplete = (
  evidenceId: string,
  entities: readonly RuntimeReconciliationEntity[],
): boolean =>
  entities.find(({ capture }) => capture.evidence.evidence_id === evidenceId)
    ?.capture.scriptsCompleteWithinScope === true;

const isLoadStateNode = (
  node: ApplicationNode,
): node is ApplicationNode & {
  readonly kind: "javascript-asset" | "javascript-chunk" | "javascript-module";
} =>
  node.kind === "javascript-asset" ||
  node.kind === "javascript-chunk" ||
  node.kind === "javascript-module";

const state = (
  layer: ParsedStaticLayer,
  node: ApplicationNode & {
    readonly kind:
      | "javascript-asset"
      | "javascript-chunk"
      | "javascript-module";
  },
  input: {
    readonly status: JavaScriptStaticLoadState["status"];
    readonly runtimeNodeIds: readonly string[];
    readonly reason: JavaScriptStaticLoadState["reason"];
  },
): JavaScriptStaticLoadState => ({
  static_layer_id: layer.layerId,
  static_node_id: node.node_id,
  kind: node.kind,
  status: input.status,
  runtime_node_ids: [...input.runtimeNodeIds],
  reason: input.reason,
});

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodePoints);
