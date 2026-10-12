import {
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphUnknown,
  sealTransferredJavaScriptSemanticGraphSteps,
  type JavaScriptSemanticGraph,
} from "../../domain/javascript/javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticFingerprint,
  JavaScriptSemanticGraphNode,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
  JAVASCRIPT_SEMANTIC_RELATIONS,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type {
  JavaScriptSemanticCallArgument,
  JavaScriptSemanticIr,
} from "../../domain/javascript/javascriptSemanticIr.js";
import { sourceRangesEqual as rangesEqual } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import type { JavaScriptApplicationGraph } from "../../domain/javascript/javascriptApplicationGraph.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  projectSemanticEvents,
  projectSemanticTimers,
} from "./JavaScriptSemanticGraphAsyncProjection.js";
import { projectSemanticChildProcesses } from "./JavaScriptSemanticGraphChildProcessProjection.js";
import {
  projectSemanticBoundaries,
  projectSemanticConfiguration,
  projectSemanticRequests,
} from "./JavaScriptSemanticGraphDataProjection.js";
import { projectSemanticResources } from "./JavaScriptSemanticGraphResourceProjection.js";
import { projectSemanticObjects } from "./JavaScriptSemanticGraphObjectProjection.js";
import { projectSemanticValues } from "./JavaScriptSemanticGraphValueProjection.js";
import { inferredSemanticEvidenceAt } from "./JavaScriptSemanticGraphEvidence.js";
import { observedSemanticEvidence } from "./JavaScriptSemanticGraphEvidence.js";
import {
  partialApplicationCoverage,
  type ApplicationCoverage,
} from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
  JAVASCRIPT_SEMANTIC_NODE_MAXIMUM,
  javaScriptAnalysisCoverageLimits,
} from "../../domain/javascript/javascriptAnalysisResourceControls.js";
import { projectSemanticFunctionFingerprints } from "./JavaScriptSemanticGraphFingerprintProjection.js";
import {
  projectSemanticClosureCaptures,
  projectSemanticFrontiers,
  projectSemanticPromises,
  projectSemanticReturnValues,
  type SemanticFlowProjectionContext,
} from "./JavaScriptSemanticGraphFlowProjection.js";
import {
  createSemanticCallableOwnerLookup,
  createSemanticCallSiteLookup,
  createSemanticNodeRangeLookup,
  semanticFamilyStatus,
} from "./JavaScriptSemanticGraphProjection.js";
import {
  addSemanticFallbackRoot as addFallbackRoot,
  retainSemanticGraphNode as retainNode,
  addSemanticGraphRelation as addRelation,
  createSemanticGraphProjectionState as emptyState,
  bindSemanticGraphApplicationNodes,
  type SemanticGraphProjectionState as BuilderState,
} from "./JavaScriptSemanticGraphConstruction.js";
import type { JavaScriptSemanticFileProjection } from "../../domain/javascript/javascriptSemanticFileProjection.js";
import type { ElectronCallPath } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import { projectElectronSemanticCallPaths } from "./JavaScriptSemanticGraphElectronProjection.js";

interface BuilderInput {
  readonly rootArtifactSha256: string;
  readonly applicationGraph: Pick<
    JavaScriptApplicationGraph,
    "graph_id" | "nodes"
  >;
  readonly analysis: JavaScriptArtifactAnalysis;
}

interface FileContext extends SemanticFlowProjectionContext {
  readonly file: JavaScriptArtifactFile;
  readonly ir: JavaScriptSemanticIr;
  readonly state: BuilderState;
  readonly moduleNode: JavaScriptSemanticGraphNode;
  readonly bindingNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly callableNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly callSiteNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly returnSiteNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly argumentNodes: Map<string, JavaScriptSemanticGraphNode>;
  readonly referenceNodes: JavaScriptSemanticGraphNode[];
  readonly callResolutions: ReadonlyMap<string, "candidate" | "resolved">;
  readonly callableOwnerAt: ReturnType<
    typeof createSemanticCallableOwnerLookup
  >;
}

/**
 * Resource-safety ceiling on retained semantic nodes.
 *
 * The semantic projection emits one node per AST expression, call site, binding
 * and property slot. That is unbounded in input size. A small tree of five files
 * already yields on the order of 170,000 nodes, and larger trees yield millions,
 * exhausting the heap before the result can be serialized.
 *
 * This is a real resource-safety constraint, not a presentation preference, so
 * the ceiling is applied and reported through the graph's own `coverage` fields
 * (`truncated`, `omitted_nodes`, `omitted_relations`, `limits`) rather than
 * silently dropping data.
 *
 * Defaults bound work even when ample heap is available. Callers may raise the
 * capacities explicitly; isolated worker heap, bounded record transport and
 * parent result admission independently constrain actual retained memory. The
 * result uses incremental serialization rather than a single JSON string.
 */
export const SEMANTIC_GRAPH_NODE_CEILING =
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticNodes;

/**
 * Per-file share of the semantic node budget.
 *
 * Bound each source file independently so one large bundled library cannot
 * consume the whole tree's budget and starve the application's own modules.
 */
export const SEMANTIC_GRAPH_FILE_NODE_CEILING =
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticNodesPerFile;

export const buildJavaScriptSemanticGraph = ({
  rootArtifactSha256,
  applicationGraph,
  analysis,
}: BuilderInput): JavaScriptSemanticGraph => {
  const projection = createJavaScriptSemanticGraphProjection();
  for (const analyzed of analysis.files) {
    if (analyzed.semantic !== null)
      projection.projectFile(
        analyzed.file,
        analyzed.semantic.ir,
        analyzed.javascript?.electron.call_paths,
      );
    else if (
      !analyzed.file.text.included &&
      analyzed.file.text.reason === "outside-analysis-scope"
    )
      projection.recordUnavailableFile(
        analyzed.file,
        "Source was not analyzed because it is outside the caller-selected source_paths.",
        null,
        "incomplete-module",
      );
  }
  return projection.finish(rootArtifactSha256, applicationGraph);
};

/** File-local semantic projection that does not retain consumed source IR. */
export interface JavaScriptSemanticGraphProjection {
  /** Node capacity offered to the next independently analyzed source file. */
  readonly remainingFileNodeBudget: () => number;
  /** Adopt decoded file-local facts; final validation and proof remain in this realm. */
  readonly adoptFileProjection: (
    projection: JavaScriptSemanticFileProjection,
  ) => void;
  /** Preserve source-bound unknowns for an execution or result-retention failure. */
  readonly recordUnavailableFile: (
    file: JavaScriptArtifactFile,
    reason: string,
    limits: Readonly<Record<string, JsonValue>> | null,
    unknownReason: "resource-limit" | "incomplete-module",
  ) => void;
  readonly projectFile: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
    paths?: readonly ElectronCallPath[],
  ) => void;
  /** Project one file in steps between its projection passes. */
  readonly projectFileSteps: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
    paths?: readonly ElectronCallPath[],
  ) => Generator<void, void>;
  readonly finish: (
    rootArtifactSha256: string,
    applicationGraph: BuilderInput["applicationGraph"],
  ) => JavaScriptSemanticGraph;
  readonly finishImmutableSteps: (
    rootArtifactSha256: string,
    applicationGraph: BuilderInput["applicationGraph"],
  ) => Generator<void, JavaScriptSemanticGraph>;
}

/** Accumulate semantic nodes while each source IR is still file-local. */
export const createJavaScriptSemanticGraphProjection = (
  limits: { readonly totalNodes?: number; readonly fileNodes?: number } = {},
): JavaScriptSemanticGraphProjection => {
  const nodeCeiling = limits.totalNodes ?? SEMANTIC_GRAPH_NODE_CEILING;
  const fileNodeCeiling = limits.fileNodes ?? SEMANTIC_GRAPH_FILE_NODE_CEILING;
  for (const value of [nodeCeiling, fileNodeCeiling])
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > JAVASCRIPT_SEMANTIC_NODE_MAXIMUM
    )
      throw new RangeError("Semantic graph requires valid node capacities");
  const state = emptyState();
  const fingerprints: JavaScriptSemanticFingerprint[] = [];
  let truncatedFiles = 0;
  let unavailableFiles = 0;
  let resourceTruncatedFiles = 0;
  const executionLimits = new Map<
    string,
    ApplicationCoverage["limits"][number]
  >();
  const projectSourceSteps = function* (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
    paths: readonly ElectronCallPath[] = [],
  ): Generator<void, void> {
    if (state.nodes.size >= nodeCeiling) {
      truncatedFiles += 1;
      return;
    }
    const remainingTreeBudget = nodeCeiling - state.nodes.size;
    state.fileNodeBudget = Math.min(fileNodeCeiling, remainingTreeBudget);
    state.fileNodesDropped = false;
    fingerprints.push(...(yield* projectFileSteps(file, ir, state, paths)));
    // Nodes were dropped only if the budget actually blocked creation. A file
    // that exactly fills its share ends with a zero budget without dropping
    // anything, so the remaining budget alone cannot decide truncation.
    if (state.fileNodesDropped) truncatedFiles += 1;
    state.fileNodeBudget = null;
  };
  const finishWith = <Value>(
    factory: (input: unknown) => Value,
    rootArtifactSha256: string,
    applicationGraph: BuilderInput["applicationGraph"],
  ): Value => {
    bindSemanticGraphApplicationNodes(state, applicationGraph);
    if (state.roots.size === 0) addFallbackRoot(rootArtifactSha256, state);
    const relations = [...state.relations.values()];
    const unknowns = [...state.unknowns.values()];
    type Family = (typeof JAVASCRIPT_SEMANTIC_RELATION_FAMILIES)[number];
    const retainedByFamily = new Map<Family, number>();
    const unknownIdsByFamily = new Map<Family, string[]>();
    for (const relation of relations) {
      const family = JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation.relation];
      retainedByFamily.set(family, (retainedByFamily.get(family) ?? 0) + 1);
    }
    for (const unknown of unknowns) {
      const identifiers = unknownIdsByFamily.get(unknown.family);
      if (identifiers === undefined)
        unknownIdsByFamily.set(unknown.family, [unknown.unknown_id]);
      else identifiers.push(unknown.unknown_id);
    }
    const graph = factory({
      schema: "JavaScriptSemanticRelationGraph",
      root_artifact_sha256: rootArtifactSha256,
      application_graph_id: applicationGraph.graph_id,
      root_node_ids: [...state.roots],
      evidence_contexts: state.evidenceContexts.contexts,
      nodes: [...state.nodes.values()],
      relations,
      // The input is transferred to the factory; `fingerprints` is cleared below.
      fingerprints: [...fingerprints],
      unknowns,
      coverage: {
        status:
          truncatedFiles > 0 || unavailableFiles > 0 ? "partial" : "unknown",
        truncated: truncatedFiles > 0 || resourceTruncatedFiles > 0,
        omitted_nodes: truncatedFiles > 0 || unavailableFiles > 0 ? null : 0,
        omitted_relations:
          truncatedFiles > 0 || unavailableFiles > 0 ? null : 0,
        limits: [
          ...executionLimits.values(),
          ...(truncatedFiles > 0
            ? [
                {
                  name: "semantic_graph_node_ceiling",
                  value: nodeCeiling,
                  unit: "items" as const,
                },
                {
                  name: "semantic_graph_file_node_ceiling",
                  value: fileNodeCeiling,
                  unit: "items" as const,
                },
              ]
            : []),
        ],
        families: JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => ({
          family,
          status: semanticFamilyStatus(family),
          retained_relations: retainedByFamily.get(family) ?? 0,
          omitted_relations:
            truncatedFiles > 0 || unavailableFiles > 0 ? null : 0,
          unknown_ids: unknownIdsByFamily.get(family) ?? [],
        })),
      },
      limitations: [
        "The semantic graph contains static syntax observations and conservative relationship candidates; it does not claim runtime execution.",
        "Local data flow does not claim control-flow-sensitive reaching definitions or arbitrary dynamic property resolution.",
        "Promise ownership covers explicit unshadowed Promise construction, static factories, aggregation, chaining, and await syntax only.",
        "Function fingerprints are static candidates; equal digests can remain ambiguous and do not prove behavioral equivalence.",
        "Event extraction covers EventEmitter-style literal registrations, removals, and dispatch candidates; dynamic names remain unknown.",
        "Timer extraction covers global or node:timers scheduling and exact local-handle cancellation.",
        "Child-process extraction covers asynchronous node:child_process creation, literal argv/env/stdio options, exit/error listeners, and kill signals.",
        "Configuration extraction covers process.env, process.argv, node:fs reads, and direct logical defaults.",
        "Request extraction covers fetch, WebSocket, node:http/node:https construction, direct option fields, and exact local response consumers.",
        "Boundary extraction covers unshadowed JSON/global coercions plus parse and validation method candidates.",
        "Resource extraction covers built-in filesystem/network acquisition and exact local close/destroy/end handles.",
      ],
    });
    state.nodes.clear();
    state.relations.clear();
    state.unknowns.clear();
    state.roots.clear();
    state.evidenceContexts.clear();
    fingerprints.length = 0;
    return graph;
  };
  return {
    remainingFileNodeBudget: () =>
      Math.min(fileNodeCeiling, Math.max(0, nodeCeiling - state.nodes.size)),
    adoptFileProjection: (projection) => {
      const newNodes = projection.nodes.filter(
        ({ node_id }) => !state.nodes.has(node_id),
      );
      if (
        newNodes.length >
        Math.min(fileNodeCeiling, nodeCeiling - state.nodes.size)
      )
        throw new RangeError(
          "Transferred semantic nodes exceed the offered tree capacity",
        );
      for (const context of projection.evidenceContexts)
        state.evidenceContexts.adopt(context);
      for (const node of newNodes) state.nodes.set(node.node_id, node);
      for (const relation of projection.relations)
        state.relations.set(relation.relation_id, relation);
      for (const unknown of projection.unknowns)
        state.unknowns.set(unknown.unknown_id, unknown);
      for (const root of projection.roots) state.roots.add(root);
      fingerprints.push(...projection.fingerprints);
      if (projection.truncated) truncatedFiles += 1;
    },
    recordUnavailableFile: (file, reason, limits, unknownReason) => {
      const retainedLimits = javaScriptAnalysisCoverageLimits(limits);
      for (const limit of retainedLimits) {
        executionLimits.set(
          JSON.stringify([limit.name, limit.value, limit.unit]),
          limit,
        );
      }
      state.fileNodeBudget = Math.min(
        fileNodeCeiling,
        Math.max(0, nodeCeiling - state.nodes.size),
      );
      const module = retainNode(state, file, {
        kind: "module",
        roleKey: "module",
        location: null,
        label: file.path,
        functionNodeId: null,
      });
      state.fileNodeBudget = null;
      if (module !== null) state.roots.add(module.node_id);
      const evidence = {
        ...observedSemanticEvidence(file, null),
        authority: "unknown" as const,
        state: "unknown" as const,
        confidence: "unknown" as const,
        coverage: partialApplicationCoverage(retainedLimits, null),
        limitations: [reason],
      };
      for (const family of JAVASCRIPT_SEMANTIC_RELATION_FAMILIES) {
        const unknown = createJavaScriptSemanticGraphUnknown(
          {
            node_id: module?.node_id ?? null,
            family,
            relation_kinds: JAVASCRIPT_SEMANTIC_RELATIONS.filter(
              (relation) =>
                JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation] === family,
            ),
            reason: unknownReason,
            detail: reason,
            candidate_node_ids: [],
            evidence,
          },
          state.evidenceContexts,
        );
        state.unknowns.set(unknown.unknown_id, unknown);
      }
      unavailableFiles += 1;
      if (unknownReason === "resource-limit" && retainedLimits.length > 0)
        resourceTruncatedFiles += 1;
    },
    projectFile: (file, ir, paths) => {
      const steps = projectSourceSteps(file, ir, paths);
      while (steps.next().done !== true);
    },
    projectFileSteps: projectSourceSteps,
    finish: (rootArtifactSha256, applicationGraph) =>
      finishWith(
        createJavaScriptSemanticGraph,
        rootArtifactSha256,
        applicationGraph,
      ),
    finishImmutableSteps: (rootArtifactSha256, applicationGraph) =>
      finishWith(
        sealTransferredJavaScriptSemanticGraphSteps,
        rootArtifactSha256,
        applicationGraph,
      ),
  };
};

/** Project one source with the parent's remaining node capacity, retaining no full IR. */
export function* projectJavaScriptSemanticFileSteps(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  nodeBudget: number,
  paths: readonly ElectronCallPath[] = [],
): Generator<void, JavaScriptSemanticFileProjection> {
  if (
    !Number.isSafeInteger(nodeBudget) ||
    nodeBudget < 0 ||
    nodeBudget > JAVASCRIPT_SEMANTIC_NODE_MAXIMUM
  )
    throw new RangeError(
      "File semantic projection requires a valid offered node capacity",
    );
  const state = emptyState();
  state.fileNodeBudget = nodeBudget;
  state.fileNodesDropped = false;
  const fingerprints = yield* projectFileSteps(file, ir, state, paths);
  return {
    roots: [...state.roots],
    evidenceContexts: state.evidenceContexts.contexts,
    nodes: [...state.nodes.values()],
    relations: [...state.relations.values()],
    unknowns: [...state.unknowns.values()],
    fingerprints,
    truncated: Boolean(state.fileNodesDropped),
  };
}

function* projectFileSteps(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  state: BuilderState,
  paths: readonly ElectronCallPath[] = [],
): Generator<void, JavaScriptSemanticFingerprint[]> {
  yield;
  const moduleNode = retainNode(state, file, {
    kind: "module",
    roleKey: "module",
    location: null,
    label: file.path,
    functionNodeId: null,
  });
  if (moduleNode === null) return [];
  state.roots.add(moduleNode.node_id);
  yield* projectElectronSemanticCallPaths(file, paths, state);
  // Node creation keeps source order, which the per-file node budget relies
  // on; yields between nodes do not change it.
  const callableNodes = new Map<string, JavaScriptSemanticGraphNode>();
  for (const [index, callable] of ir.callables.entries()) {
    if (index % 64 === 0) yield;
    const node = retainNode(state, file, {
      kind: "function",
      roleKey: `callable:${callable.callableId}`,
      location: callable.location,
      label: callable.name,
      functionNodeId: null,
      // The label is display text; keep the exact name, which may be "".
      properties: { name: callable.name },
    });
    if (node !== null) callableNodes.set(callable.callableId, node);
  }
  const callableOwnerAt = createSemanticCallableOwnerLookup(ir, callableNodes);
  const bindingNodes = new Map<string, JavaScriptSemanticGraphNode>();
  for (const [index, binding] of ir.bindings.entries()) {
    if (index % 64 === 0) yield;
    const location = binding.definitions[0]?.location ?? null;
    const kind = binding.kind === "parameter" ? "parameter" : "binding";
    const owner = callableOwnerAt(location);
    const node = retainNode(state, file, {
      kind,
      roleKey: `binding:${binding.bindingId}`,
      location,
      label: binding.name,
      functionNodeId: owner?.node_id ?? null,
    });
    if (node !== null) bindingNodes.set(binding.bindingId, node);
  }
  const returnSiteNodes = yield* createReturnSiteNodes(
    file,
    ir,
    callableNodes,
    state,
  );
  const callSiteNodes = yield* createCallSiteNodes(
    file,
    ir,
    callableNodes,
    state,
  );
  const definitions: Omit<FileContext, "referenceNodesWithin"> = {
    file,
    ir,
    state,
    moduleNode,
    bindingNodes,
    callableNodes,
    callSiteNodes,
    returnSiteNodes,
    argumentNodes: new Map(),
    referenceNodes: [],
    callResolutions: new Map(
      ir.callSites.map((call) => [
        call.callSiteId,
        call.resolution === "exact" ? "resolved" : "candidate",
      ]),
    ),
    callableOwnerAt,
    callSiteAt: createSemanticCallSiteLookup(ir, callSiteNodes),
  };
  yield* projectDefinitionsAndReferences(definitions);
  const context: FileContext = {
    ...definitions,
    referenceNodesWithin: createSemanticNodeRangeLookup(
      definitions.referenceNodes,
    ),
  };
  // Each pass completes before the next starts, so yielding between passes
  // keeps projection order and results unchanged.
  for (const project of FILE_PROJECTION_PASSES) {
    yield;
    const steps = project(context);
    if (steps !== undefined) while (steps.next().done !== true) yield;
  }
  yield;
  return projectSemanticFunctionFingerprints(
    file,
    ir,
    callableNodes,
    state.evidenceContexts,
  );
}

function* createReturnSiteNodes(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  callables: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  state: BuilderState,
): Generator<void, Map<string, JavaScriptSemanticGraphNode>> {
  const result = new Map<string, JavaScriptSemanticGraphNode>();
  for (const [index, callable] of ir.callables.entries()) {
    if (index % 64 === 0) yield;
    const owner = callables.get(callable.callableId);
    if (owner === undefined) continue;
    for (const site of callable.returnSites) {
      const identifier = site.returnSiteId;
      const node = retainNode(state, file, {
        kind: "return-site",
        roleKey: identifier,
        location: site.location,
        label: "return",
        functionNodeId: owner.node_id,
      });
      if (node !== null) result.set(identifier, node);
    }
  }
  return result;
}

function* createCallSiteNodes(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  callables: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  state: BuilderState,
): Generator<void, Map<string, JavaScriptSemanticGraphNode>> {
  const result = new Map<string, JavaScriptSemanticGraphNode>();
  for (const [index, call] of ir.callSites.entries()) {
    if (index % 64 === 0) yield;
    const owner =
      call.callerCallableId === null
        ? null
        : (callables.get(call.callerCallableId)?.node_id ?? null);
    const node = retainNode(state, file, {
      kind: "call-site",
      roleKey: `call:${call.callSiteId}`,
      location: call.location,
      label: call.kind,
      functionNodeId: owner,
    });
    if (node !== null) result.set(call.callSiteId, node);
  }
  return result;
}

function* projectDefinitionsAndReferences(
  context: Omit<FileContext, "referenceNodesWithin">,
): Generator<void, void> {
  for (const [bindingIndex, binding] of context.ir.bindings.entries()) {
    if (bindingIndex % 64 === 0) yield;
    const bindingNode = context.bindingNodes.get(binding.bindingId);
    if (bindingNode === undefined) continue;
    for (const [index, definition] of binding.definitions.entries()) {
      const definitionNode = retainNode(context.state, context.file, {
        kind: "expression",
        roleKey: `definition:${binding.bindingId}:${String(index)}`,
        location: definition.location,
        label: definition.kind,
        functionNodeId: bindingNode.function_node_id,
      });
      addRelation(context.state, {
        source: definitionNode,
        target: bindingNode,
        relation: "defines",
        resolution: "resolved",
      });
    }
  }
  for (const [index, reference] of context.ir.references.entries()) {
    if (index % 64 === 0) yield;
    const expression = retainNode(context.state, context.file, {
      kind: "expression",
      roleKey: `reference:${String(index)}:${reference.role}:${reference.name}`,
      location: reference.location,
      label: reference.name,
      functionNodeId:
        context.callableOwnerAt(reference.location)?.node_id ?? null,
    });
    const binding =
      reference.bindingId === null
        ? undefined
        : context.bindingNodes.get(reference.bindingId);
    if (expression !== null) context.referenceNodes.push(expression);
    if (binding === undefined || expression === null) continue;
    if (reference.role === "read")
      addRelation(context.state, {
        source: binding,
        target: expression,
        relation: "reads",
        resolution: "resolved",
        evidence: inferredSemanticEvidenceAt(context.file, reference.location),
      });
    else
      addRelation(context.state, {
        source: expression,
        target: binding,
        relation: "writes",
        resolution: "resolved",
      });
  }
}

const projectCalls = (context: FileContext): void => {
  for (const call of context.ir.callSites) {
    const callNode = context.callSiteNodes.get(call.callSiteId);
    if (callNode === undefined) continue;
    for (const callableId of call.calleeCallableIds) {
      const callable = context.callableNodes.get(callableId);
      addRelation(context.state, {
        source: callNode,
        target: callable,
        relation: "calls",
        resolution: call.resolution === "exact" ? "resolved" : "candidate",
      });
    }
    for (const argument of call.arguments) {
      const argumentNode = createArgumentNode(
        context,
        callNode,
        call.callSiteId,
        argument,
      );
      if (argumentNode !== null)
        context.argumentNodes.set(
          `${call.callSiteId}\u0000${String(argument.index)}`,
          argumentNode,
        );
      const references = context.referenceNodesWithin(argument.location);
      for (const reference of references)
        addRelation(context.state, {
          source: reference,
          target: argumentNode,
          relation: "aliases",
          resolution:
            references.length === 1 &&
            rangesEqual(reference.identity.source_range, argument.location)
              ? "resolved"
              : "candidate",
        });
    }
  }
  for (const flow of context.ir.argumentFlows) {
    const argument = context.argumentNodes.get(
      `${flow.callSiteId}\u0000${String(flow.argumentIndex)}`,
    );
    const parameter = context.bindingNodes.get(flow.parameterBindingId);
    addRelation(context.state, {
      source: argument,
      target: parameter,
      relation: "argument-to-parameter",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  }
  for (const flow of context.ir.callReturnFlows)
    addRelation(context.state, {
      source: context.returnSiteNodes.get(flow.returnSiteId),
      target: context.callSiteNodes.get(flow.callSiteId),
      relation: "returns-to-call",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  for (const flow of context.ir.callResultFlows)
    addRelation(context.state, {
      source: context.callSiteNodes.get(flow.callSiteId),
      target: context.bindingNodes.get(flow.bindingId),
      relation: "aliases",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  projectSemanticReturnValues(context);
};

const createArgumentNode = (
  context: FileContext,
  callNode: JavaScriptSemanticGraphNode,
  callSiteId: string,
  argument: JavaScriptSemanticCallArgument,
): JavaScriptSemanticGraphNode | null =>
  retainNode(context.state, context.file, {
    kind: "expression",
    roleKey: `argument:${callSiteId}:${String(argument.index)}`,
    location: argument.location,
    label: argument.spread
      ? "spread argument"
      : `argument ${String(argument.index)}`,
    functionNodeId: callNode.function_node_id,
  });

/** Per-file projection passes, run in this order with a yield between each. */
const FILE_PROJECTION_PASSES: readonly ((
  context: FileContext,
) => Iterator<void, void> | void)[] = [
  projectSemanticValues,
  projectSemanticObjects,
  projectCalls,
  projectSemanticPromises,
  projectSemanticEvents,
  projectSemanticTimers,
  projectSemanticChildProcesses,
  projectSemanticConfiguration,
  projectSemanticRequests,
  projectSemanticBoundaries,
  projectSemanticResources,
  projectSemanticClosureCaptures,
  projectSemanticFrontiers,
];
