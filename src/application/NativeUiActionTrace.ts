import { z } from "zod";

import type { AnalysisOperationPort } from "./AnalysisProvider.js";
import type { EnhancedResult } from "./EnhancedToolTypes.js";
import type { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { interfaceBuilderAnalysisSchema } from "../domain/interfaceBuilderGraph.js";
import {
  nativeInvestigationGraphSchema,
  nativeInvestigationTraceSchema,
  traceNativeInvestigationGraph,
  joinInterfaceBuilderDispatch,
} from "../domain/nativeInvestigationGraph.js";
import { nativeDispatchMetadataResultSchema } from "../domain/objcSwiftMetadata.js";
import { inspectNativeDispatch } from "./NativeDispatchMetadataInspection.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { readNativeCallRoutes } from "./NativeCallRoutes.js";
import { err, ok } from "../domain/result.js";
import { AnalysisOutputError, projectAnalysisError } from "../domain/errors.js";

type Input = z.output<typeof enhancedInputSchemas.trace_native_ui_action>;
/** Build a UI-to-code trace from the active app and selected native provider. */
export const traceNativeUiAction = async (
  analysis: AnalysisOperationPort,
  input: Input,
  signal?: AbortSignal,
): EnhancedResult => {
  const [uiExecution, metadataExecution] = await Promise.all([
    analysis.execute(
      "decode_interface_builder",
      {
        max_documents: 64,
        max_objects: input.max_nodes,
        max_connections: input.max_edges,
      },
      signal === undefined ? {} : { signal },
    ),
    inspectNativeDispatch(analysis, 20_000, signal),
  ]);
  if (!uiExecution.ok && uiExecution.error._tag === "AnalysisCancelledError")
    return err(uiExecution.error);
  if (!metadataExecution.ok) return err(metadataExecution.error);
  const metadata = nativeDispatchMetadataResultSchema.parse(
    metadataExecution.value,
  );
  const targetSha256 = metadata.target_sha256;
  if (targetSha256 === null)
    return err(
      new AnalysisOutputError(
        "inspect_native_dispatch_metadata",
        "Dispatch metadata lacks target identity",
      ),
    );

  let graph = emptyGraph(targetSha256, metadata.provider);
  const coverage = [];
  if (uiExecution.ok) {
    const decoded = interfaceBuilderAnalysisSchema.safeParse(
      uiExecution.value.result,
    );
    if (!decoded.success)
      return err(
        new AnalysisOutputError(
          "decode_interface_builder",
          "artifact provider returned an invalid interface graph",
        ),
      );
    if (decoded.data.target_sha256 !== targetSha256)
      return err(
        new AnalysisOutputError(
          "decode_interface_builder",
          "UI and native provider results refer to different target SHA-256 values",
        ),
      );
    graph = joinInterfaceBuilderDispatch(decoded.data.graph, metadata.result);
    coverage.push({
      facet: "interface_builder_archives",
      status: decoded.data.documents.length > 0 ? "complete" : "unsupported",
      reason:
        decoded.data.documents.length > 0
          ? null
          : "no_compiled_interface_builder_archives_found",
      examined: decoded.data.documents.length,
      omitted: 0,
    });
    const bounded = boundUiGraph(graph, input.max_nodes, input.max_edges);
    graph = bounded.graph;
    if (bounded.truncated)
      coverage.push({
        facet: "interface_builder_graph",
        status: "partial",
        reason: "native_trace_output_bounds_reached",
        examined:
          decoded.data.graph.nodes.length + decoded.data.graph.edges.length,
        omitted: bounded.omitted,
      });
  } else {
    coverage.push({
      facet: "interface_builder_archives",
      status: "unsupported",
      reason: projectAnalysisError(uiExecution.error).message,
      examined: 0,
      omitted: 0,
    });
  }

  let selected = resolveUiAction(graph, input.action);
  if (selected.nodeId === null && selected.candidates.length === 0) {
    const native = await analysis.execute(
      "procedure_address",
      { procedure: input.action },
      signal === undefined ? {} : { signal },
    );
    if (!native.ok && native.error._tag === "AnalysisCancelledError")
      return err(native.error);
    if (native.ok) {
      const address = z.string().safeParse(native.value.result);
      if (!address.success || native.value.subject?.sha256 !== targetSha256)
        return err(
          new AnalysisOutputError(
            "procedure_address",
            "Native seed lacks a validated address or matching target identity",
          ),
        );
      const id = `native:function:${address.data}`;
      graph.nodes.push({
        id,
        kind: "function",
        name: input.action,
        location: { address: address.data, file_offset: null },
        attributes: { resolved_by: native.value.provider.id },
        evidence: [
          {
            kind: "reference",
            description: `Provider resolved the explicit native seed ${input.action}`,
            location: { address: address.data, file_offset: null },
            artifact_path: null,
            artifact_sha256: targetSha256,
          },
        ],
      });
      selected = { nodeId: id, candidates: [], reason: null };
    }
  }
  if (selected.nodeId === null) {
    coverage.push(...graph.coverage);
    const trace = {
      target_sha256: graph.target_sha256,
      provider: graph.provider,
      start: input.action,
      direction: "forward" as const,
      nodes: selected.candidates,
      edges: [],
      unresolved: [],
      reached_depth: 0,
      truncated: graph.truncated,
      reason: selected.reason,
      coverage,
      limitations: [
        "The query did not identify one unique authored UI action or native function; no handler path was inferred.",
      ],
    };
    return ok(
      jsonValueSchema.parse(nativeInvestigationTraceSchema.parse(trace)),
    );
  }

  const initial = traceNativeInvestigationGraph(graph, {
    start: selected.nodeId,
    direction: "forward",
    limits: {
      max_depth: input.max_depth,
      max_nodes: input.max_nodes,
      max_edges: input.max_edges,
    },
  });
  const expanded = await addDirectCallees({
    analysis,
    graph,
    initial,
    input,
    targetSha256,
    signal,
  });
  if (expanded.error !== undefined) return err(expanded.error);
  coverage.push({
    facet: "static_native_calls",
    status: "partial",
    reason:
      "typed_direct_and_indirect_references_do_not_cover_all_runtime_dispatch; untyped_provider_callees_remain_inferred",
    examined: expanded.examined,
    omitted: expanded.omitted,
  });
  coverage.push({
    facet: "cross_function_value_flow",
    status: "unsupported",
    reason:
      "call edges identify control-flow candidates but do not recover argument, return, or shared-memory value relationships",
    examined: 0,
    omitted: 0,
  });

  const finalGraph = nativeInvestigationGraphSchema.parse({
    ...graph,
    nodes: expanded.nodes,
    edges: expanded.edges,
    coverage: [...graph.coverage, ...coverage],
    truncated: graph.truncated || expanded.truncated,
  });
  const trace = traceNativeInvestigationGraph(finalGraph, {
    start: selected.nodeId,
    direction: "forward",
    limits: {
      max_depth: input.max_depth,
      max_nodes: input.max_nodes,
      max_edges: input.max_edges,
    },
  });
  return ok(
    jsonValueSchema.parse(
      nativeInvestigationTraceSchema.parse({
        ...trace,
        truncated: trace.truncated || expanded.truncated || graph.truncated,
        reason:
          expanded.truncated && trace.reason === null
            ? "native_call_traversal_bound_reached"
            : graph.truncated && trace.reason === null
              ? "native_trace_output_bound_reached"
              : trace.reason,
      }),
    ),
  );
};

const emptyGraph = (
  targetSha256: string,
  provider: {
    readonly id: string;
    readonly version: string | null;
  },
) =>
  nativeInvestigationGraphSchema.parse({
    target_sha256: targetSha256,
    provider: {
      id: provider.id,
      version: provider.version,
      tool_version: "rea-native-ui-trace/1",
    },
    nodes: [],
    edges: [],
    coverage: [],
    truncated: false,
  });

const boundUiGraph = (
  graph: z.infer<typeof nativeInvestigationGraphSchema>,
  maxNodes: number,
  maxEdges: number,
): {
  readonly graph: z.infer<typeof nativeInvestigationGraphSchema>;
  readonly truncated: boolean;
  readonly omitted: number;
} => {
  const nodes = graph.nodes.slice(0, maxNodes);
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const eligibleEdges = graph.edges.filter(
    (edge) =>
      nodeIds.has(edge.from) && (edge.to === null || nodeIds.has(edge.to)),
  );
  const edges = eligibleEdges.slice(0, maxEdges);
  const omitted =
    graph.nodes.length - nodes.length + graph.edges.length - edges.length;
  const truncated = omitted > 0;
  return {
    graph: nativeInvestigationGraphSchema.parse({
      ...graph,
      nodes,
      edges,
      truncated: graph.truncated || truncated,
    }),
    truncated,
    omitted,
  };
};

const resolveUiAction = (
  graph: z.infer<typeof nativeInvestigationGraphSchema>,
  query: string,
): {
  readonly nodeId: string | null;
  readonly candidates: z.infer<typeof nativeInvestigationGraphSchema>["nodes"];
  readonly reason: string | null;
} => {
  const exactId = graph.nodes.find((node) => node.id === query);
  if (exactId?.kind === "action")
    return { nodeId: exactId.id, candidates: [], reason: null };

  const actions = graph.nodes.filter(
    (node) =>
      node.kind === "action" &&
      (node.name === query || node.attributes.selector === query),
  );
  if (actions.length === 1)
    return { nodeId: actions[0]?.id ?? null, candidates: [], reason: null };
  if (actions.length > 1)
    return {
      nodeId: null,
      candidates: actions,
      reason: "action_selector_matches_multiple_ui_connections",
    };

  const objectMatches = graph.nodes.filter(
    (node) =>
      ["control", "view", "view_controller", "scene"].includes(node.kind) &&
      (node.id === query ||
        node.attributes.interface_builder_object_id === query ||
        node.id.endsWith(`:object:${query}`)),
  );
  const actionIds = new Set(
    graph.edges.flatMap((edge) =>
      edge.resolution === "observed" &&
      edge.relation === "target_action" &&
      objectMatches.some(({ id }) => edge.from === id) &&
      graph.nodes.some(({ id, kind }) => id === edge.to && kind === "action")
        ? [edge.to]
        : [],
    ),
  );
  if (actionIds.size === 1)
    return { nodeId: [...actionIds][0] ?? null, candidates: [], reason: null };
  if (actionIds.size > 1)
    return {
      nodeId: null,
      candidates: graph.nodes.filter(({ id }) => actionIds.has(id)),
      reason: "interface_object_has_multiple_action_connections",
    };
  return {
    nodeId: null,
    candidates: [],
    reason: "ui_action_or_object_not_found",
  };
};

const addDirectCallees = async (input: {
  readonly analysis: AnalysisOperationPort;
  readonly graph: z.infer<typeof nativeInvestigationGraphSchema>;
  readonly initial: z.infer<typeof nativeInvestigationTraceSchema>;
  readonly input: Input;
  readonly targetSha256: string;
  readonly signal: AbortSignal | undefined;
}) => {
  const nodes = new Map(input.initial.nodes.map((node) => [node.id, node]));
  const edges = new Map(
    [...input.initial.edges, ...input.initial.unresolved].map((edge) => [
      edge.id,
      edge,
    ]),
  );
  const addressNames = new Map<string, string>();
  const depthByNode = graphNodeDepths(
    input.initial.start,
    input.initial.nodes,
    input.initial.edges,
  );
  for (const node of nodes.values()) {
    if (node.kind === "function" && node.location?.address !== null)
      addressNames.set(node.location?.address ?? "", node.name);
  }
  const queue = input.initial.nodes.flatMap((node) =>
    node.kind === "function" && node.location?.address != null
      ? [
          {
            node,
            address: node.location.address,
            depth: depthByNode.get(node.id) ?? input.initial.reached_depth,
          },
        ]
      : [],
  );
  const visited = new Set<string>();
  let queueIndex = 0;
  let examined = 0;
  let omitted = 0;
  let truncated = false;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++];
    if (current === undefined || visited.has(current.address)) continue;
    visited.add(current.address);
    if (current.depth >= input.input.max_depth) {
      truncated = true;
      omitted += 1;
      continue;
    }
    if (nodes.size >= input.input.max_nodes) {
      truncated = true;
      omitted += queue.length - queueIndex + 1;
      break;
    }
    const execution = await readNativeCallRoutes(
      input.analysis,
      current.address,
      input.signal,
    );
    examined += 1;
    if (!execution.ok) {
      if (execution.error._tag === "AnalysisCancelledError")
        return { error: execution.error };
      const id = `unknown-callees:${current.address}`;
      edges.set(id, {
        id,
        from: current.node.id,
        to: null,
        relation: "direct_call",
        resolution: "unresolved",
        reason: projectAnalysisError(execution.error).message,
        evidence: [],
        limitations: [
          "The provider could not enumerate resolved direct callees.",
        ],
      });
      continue;
    }
    for (const unknown of execution.value.unknowns) {
      if (edges.size >= input.input.max_edges) {
        truncated = true;
        omitted++;
        break;
      }
      const id = `unknown-dispatch:${current.address}:${unknown.address}`;
      edges.set(id, {
        id,
        from: current.node.id,
        to: null,
        relation: "indirect_call",
        resolution: "unresolved",
        reason: unknown.reason,
        evidence: [
          {
            kind: "reference",
            description: unknown.reason,
            location: { address: unknown.address, file_offset: null },
            artifact_path: null,
            artifact_sha256: input.targetSha256,
          },
        ],
        limitations: [],
      });
    }
    for (const [index, route] of execution.value.routes.entries()) {
      const address = route.address;
      if (edges.size >= input.input.max_edges) {
        truncated = true;
        omitted += execution.value.routes.length - index;
        break;
      }
      const targetId = `native:function:${address}`;
      const evidence = [
        {
          kind: "reference" as const,
          description: `${execution.value.provider.name} reported ${route.relation} from ${current.address} to ${address}`,
          location: { address: route.site, file_offset: null },
          artifact_path: null,
          artifact_sha256: input.targetSha256,
        },
      ];
      if (!nodes.has(targetId)) {
        if (nodes.size >= input.input.max_nodes) {
          truncated = true;
          omitted += 1;
          const id = `unknown-node-bound:${current.address}:${address}`;
          edges.set(id, {
            id,
            from: current.node.id,
            to: null,
            relation: "direct_call",
            resolution: "unresolved",
            reason: "native_trace_node_bound_reached",
            evidence,
            limitations: [],
          });
          continue;
        }
        const name = addressNames.get(address) ?? address;
        const node = {
          id: targetId,
          kind: "function" as const,
          name,
          location: { address, file_offset: null },
          attributes: { resolved_by: execution.value.provider.id },
          evidence,
        };
        nodes.set(targetId, node);
        queue.push({ node, address, depth: current.depth + 1 });
      }
      const edgeId = `call:${current.address}:${route.site}:${address}`;
      edges.set(edgeId, {
        id: edgeId,
        from: current.node.id,
        to: targetId,
        relation: route.relation,
        resolution: route.resolution,
        evidence,
        limitations: [
          "A resolved static call edge does not establish runtime reachability.",
        ],
      });
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    examined,
    omitted,
    truncated,
  };
};

const graphNodeDepths = (
  start: string,
  nodes: readonly z.infer<
    typeof nativeInvestigationGraphSchema
  >["nodes"][number][],
  edges: readonly z.infer<
    typeof nativeInvestigationGraphSchema
  >["edges"][number][],
): ReadonlyMap<string, number> => {
  const known = new Set(nodes.map(({ id }) => id));
  const depths = new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const depth = depths.get(current) ?? 0;
    for (const edge of edges) {
      if (
        edge.resolution === "unresolved" ||
        edge.from !== current ||
        edge.to === null ||
        !known.has(edge.to) ||
        depths.has(edge.to)
      )
        continue;
      depths.set(edge.to, depth + 1);
      queue.push(edge.to);
    }
  }
  return depths;
};
