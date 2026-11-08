import type { JavaScriptEvidenceAdmission } from "../../domain/javascript/javascriptSourceAnalysis.js";
import {
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphUnknown,
  sealTransferredJavaScriptSemanticGraphSteps,
  type JavaScriptSemanticGraph,
} from "../../domain/javascript/javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticFileCoverage,
  JavaScriptSemanticFileProjectionCoverage,
  JavaScriptSemanticFingerprint,
  JavaScriptSemanticGraphNode,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import { SemanticFileGraphBudget } from "./JavaScriptSemanticFileGraphBudget.js";
import {
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
  JAVASCRIPT_SEMANTIC_RELATIONS,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type {
  JavaScriptSemanticCallArgument,
  JavaScriptSemanticCallReturnFlow,
  JavaScriptSemanticIr,
} from "../../domain/javascript/javascriptSemanticIr.js";
import { sourceRangesEqual as rangesEqual } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import { javascriptSourceRangeKey } from "../../domain/javascript/javascriptSourceCoordinates.js";
import type { JavaScriptApplicationGraph } from "../../domain/javascript/javascriptApplicationGraph.js";
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
import { projectSemanticAssignments } from "./JavaScriptSemanticGraphAssignmentProjection.js";
import { projectSemanticExpressionInfluence } from "./JavaScriptSemanticGraphExpressionProjection.js";
import { projectSemanticObjects } from "./JavaScriptSemanticGraphObjectProjection.js";
import { projectSemanticValues } from "./JavaScriptSemanticGraphValueProjection.js";
import {
  inferredSemanticEvidenceAt,
  observedSemanticEvidence,
  unknownSemanticEvidence,
} from "./JavaScriptSemanticGraphEvidence.js";
import {
  RETURNED_REFERENCE_WIDENING_LIMITATION,
  semanticCoverageResourceLimits,
  semanticResourceLimitCoverage,
} from "../../domain/javascript/javascriptSemanticCoverage.js";
import { semanticResourceLimitReason } from "../../domain/javascript/javascriptSemanticResourceLimits.js";
import {
  partialApplicationCoverage,
  type ApplicationCoverage,
} from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
  JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES,
  JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM,
  javaScriptAnalysisCoverageLimits,
  javaScriptSemanticCeilingCoverage,
} from "../../domain/javascript/javascriptAnalysisResourceControls.js";
import {
  projectSemanticFunctionFingerprints,
  projectSemanticFunctionFingerprint,
} from "./JavaScriptSemanticGraphFingerprintProjection.js";
import {
  projectSemanticClosureCaptures,
  projectSemanticFrontiers,
  projectSemanticPromises,
  projectSemanticReturnValues,
  semanticObjectReadOccurrence,
  type SemanticFlowProjectionContext,
} from "./JavaScriptSemanticGraphFlowProjection.js";
import {
  createSemanticCallableOwnerLookup,
  createSemanticCallSiteLookup,
  createSemanticNodeRangeLookup,
  semanticFamilyStatus,
} from "./JavaScriptSemanticGraphProjection.js";
import {
  constructSemanticGraphNode,
  addSemanticFallbackRoot as addFallbackRoot,
  addSemanticGraphUnknown,
  recordSemanticUnknownOmission,
  retainSemanticGraphNode as retainNode,
  addSemanticGraphRelation as addRelation,
  createSemanticGraphProjectionState as emptyState,
  finishSemanticFileBudget,
  bindSemanticGraphApplicationNodesSteps,
  measureSemanticFilesSteps,
  admitSemanticIndexedFingerprint,
  type SemanticGraphProjectionState as BuilderState,
} from "./JavaScriptSemanticGraphConstruction.js";
import type {
  JavaScriptSemanticFileProjection,
  JavaScriptSemanticProjectionCapacity,
} from "../../domain/javascript/javascriptSemanticFileProjection.js";
import type { ElectronCallPath } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import { projectElectronSemanticCallPaths } from "./JavaScriptSemanticGraphElectronProjection.js";

type ApplicationGraph = Pick<JavaScriptApplicationGraph, "graph_id" | "nodes">;

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

/** File-local semantic projection that does not retain consumed source IR. */
export interface JavaScriptSemanticGraphProjection {
  /** Node capacity offered to the next independently analyzed source file. */
  readonly remainingFileCapacity: () => JavaScriptSemanticProjectionCapacity;
  /** Adopt decoded file-local facts; final validation and proof remain in this realm. */
  readonly adoptFileProjection: (
    file: JavaScriptArtifactFile,
    projection: JavaScriptSemanticFileProjection,
  ) => void;
  /** Preserve JavaScript-source unknowns; other file kinds have no semantic module. */
  readonly recordUnavailableFile: (
    file: JavaScriptArtifactFile,
    reason: string,
    limits: Readonly<Record<string, JsonValue>> | null,
    unknownReason: "resource-limit" | "incomplete-module",
  ) => void;
  /** Project one file without a byte budget. */
  readonly projectFile: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
    paths?: readonly ElectronCallPath[],
  ) => void;
  /** Project one file without a byte budget in steps between its projection passes. */
  readonly projectFileSteps: (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
    paths?: readonly ElectronCallPath[],
  ) => Generator<void, void>;
  /** `budgetLimits` name the limits that offered each truncated file its budget. */
  readonly finish: (
    rootArtifactSha256: string,
    applicationGraph: ApplicationGraph,
    budgetLimits?: ApplicationCoverage["limits"],
  ) => JavaScriptSemanticGraph;
  readonly finishImmutableSteps: (
    rootArtifactSha256: string,
    applicationGraph: ApplicationGraph,
    budgetLimits?: ApplicationCoverage["limits"],
  ) => Generator<void, JavaScriptSemanticGraph>;
}

/** Ceilings whose offered budget actually stopped retention. */
interface SemanticCeilingReached {
  total: boolean;
  perFile: boolean;
}

/**
 * Attribute a drop to the ceiling that bound this file's offer.
 *
 * The offer is the minimum of the per-file ceiling and the remaining
 * application room. Only that smaller ceiling stopped retention. When the
 * two values are equal, both did.
 */
const noteSemanticCeilingReached = (
  reached: SemanticCeilingReached,
  totalRoom: number,
  perFileCeiling: number,
): void => {
  if (perFileCeiling <= totalRoom) reached.perFile = true;
  if (totalRoom <= perFileCeiling) reached.total = true;
};

const semanticUnknownOccurrences = (
  omissions: ReadonlyMap<string, { readonly occurrences: number }>,
): number => {
  let count = 0;
  for (const omission of omissions.values()) count += omission.occurrences;
  return count;
};

/** Accumulate semantic nodes while each source IR is still file-local. */
export const createJavaScriptSemanticGraphProjection = (
  capacities: {
    readonly totalNodes?: number;
    readonly fileNodes?: number;
    readonly totalUnknowns?: number;
    readonly fileUnknowns?: number;
  } = {},
  evidenceBudget?: JavaScriptEvidenceAdmission,
  rootArtifactSha256?: string,
): JavaScriptSemanticGraphProjection => {
  const unknownCeiling =
    capacities.totalUnknowns ??
    JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticUnknowns;
  const fileUnknownCeiling =
    capacities.fileUnknowns ??
    JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS.semanticUnknownsPerFile;
  for (const value of [
    ...(capacities.totalNodes === undefined ? [] : [capacities.totalNodes]),
    ...(capacities.fileNodes === undefined ? [] : [capacities.fileNodes]),
    unknownCeiling,
    fileUnknownCeiling,
  ])
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM
    )
      throw new RangeError("Semantic graph requires valid retained capacities");
  const nodeLimits: ApplicationCoverage["limits"] = [
    ...(capacities.totalNodes === undefined
      ? []
      : [
          {
            name: "semantic_graph_node_ceiling",
            value: capacities.totalNodes,
            unit: "items" as const,
          },
        ]),
    ...(capacities.fileNodes === undefined
      ? []
      : [
          {
            name: "semantic_graph_file_node_ceiling",
            value: capacities.fileNodes,
            unit: "items" as const,
          },
        ]),
  ];
  const state = emptyState();
  const fallback = emptyState();
  if (rootArtifactSha256 !== undefined)
    addFallbackRoot(rootArtifactSha256, fallback);
  const fallbackBytes =
    Buffer.byteLength(JSON.stringify([...fallback.roots])) +
    [...fallback.nodes.values(), ...fallback.evidenceContexts.contexts].reduce(
      (bytes, fact) => bytes + Buffer.byteLength(JSON.stringify(fact)) + 1,
      0,
    );
  if (
    evidenceBudget !== undefined &&
    !evidenceBudget.reserveBytes(fallbackBytes)
  )
    throw new RangeError(
      "Evidence capacity cannot retain its mandatory semantic root",
    );
  let graphReservedBytes = 0;
  let coverageReservedBytes = 0;
  const remainingFileNodeBudget = (): number | null =>
    nodeLimits.length === 0
      ? null
      : Math.max(
          0,
          Math.min(
            capacities.fileNodes ?? Number.POSITIVE_INFINITY,
            (capacities.totalNodes ?? Number.POSITIVE_INFINITY) -
              state.nodes.size,
          ),
        );
  const fingerprints: JavaScriptSemanticFingerprint[] = [];
  const files: JavaScriptSemanticFileCoverage[] = [];
  let unavailableFiles = 0;
  let omittedFiles = 0;
  let resourceTruncatedFiles = 0;
  let unavailableBudgetTruncatedFiles = 0;
  const nodeCeilingsReached: SemanticCeilingReached = {
    total: false,
    perFile: false,
  };
  const noteNodeLimit = (sizeBefore: number): void => {
    const totalRoom =
      capacities.totalNodes === undefined
        ? Infinity
        : capacities.totalNodes - sizeBefore;
    const fileLimit = capacities.fileNodes ?? Infinity;
    if (capacities.fileNodes !== undefined && fileLimit <= totalRoom)
      nodeCeilingsReached.perFile = true;
    if (capacities.totalNodes !== undefined && totalRoom <= fileLimit)
      nodeCeilingsReached.total = true;
  };
  const unknownCeilingsReached: SemanticCeilingReached = {
    total: false,
    perFile: false,
  };
  const executionLimits = new Map<
    string,
    ApplicationCoverage["limits"][number]
  >();
  const projectSourceSteps = function* (
    file: JavaScriptArtifactFile,
    ir: JavaScriptSemanticIr,
    paths: readonly ElectronCallPath[] = [],
  ): Generator<void, void> {
    const nodesBefore = state.nodes.size;
    const unknownsBefore = state.unknowns.size;
    const omissionsBefore = semanticUnknownOccurrences(state.unknownOmissions);
    state.unknownCapacity = Math.min(
      unknownCeiling,
      unknownsBefore + fileUnknownCeiling,
    );
    try {
      const budget = new SemanticFileGraphBudget(
        null,
        remainingFileNodeBudget(),
      );
      const projected = yield* projectBudgetedFileSteps(
        file,
        ir,
        state,
        budget,
        paths,
      );
      if (budget.nodeLimitReached) noteNodeLimit(nodesBefore);
      for (const fingerprint of projected.fingerprints)
        fingerprints.push(fingerprint);
      files.push(fileCoverage(file, projected.coverage));
      if (semanticUnknownOccurrences(state.unknownOmissions) > omissionsBefore)
        noteSemanticCeilingReached(
          unknownCeilingsReached,
          unknownCeiling - unknownsBefore,
          fileUnknownCeiling,
        );
    } finally {
      state.unknownCapacity = null;
    }
  };
  const finishWithSteps = function* <Value>(
    factory: (input: unknown) => Value,
    rootArtifactSha256: string,
    applicationGraph: ApplicationGraph,
    budgetLimits: ApplicationCoverage["limits"],
  ): Generator<void, Value> {
    let finalBudget: SemanticFileGraphBudget | undefined;
    const before = yield* measureSemanticFilesSteps(state, fingerprints);
    if (evidenceBudget !== undefined) {
      evidenceBudget.releaseBytes(graphReservedBytes + coverageReservedBytes);
      finalBudget = new SemanticFileGraphBudget(
        evidenceBudget.remainingBytes(),
      );
    }
    yield* bindSemanticGraphApplicationNodesSteps(
      state,
      applicationGraph,
      fingerprints,
      finalBudget,
    );
    const measured = yield* measureSemanticFilesSteps(state, fingerprints);
    const retainedUnknownCounts = new Map<string, number>();
    for (const unknown of state.unknowns.values()) {
      yield;
      const context = state.evidenceContexts.context(
        unknown.evidence.context_id,
      );
      const location = unknown.evidence.location;
      if (!context.artifact.available || !location.available) continue;
      const path =
        location.value.kind === "artifact-path"
          ? location.value.path
          : location.value.kind === "source-range"
            ? location.value.source
            : null;
      if (path === null) continue;
      const key = `${context.artifact.sha256}\u0000${path}\u0000${unknown.family}\u0000${unknown.reason}`;
      retainedUnknownCounts.set(key, (retainedUnknownCounts.get(key) ?? 0) + 1);
    }
    if (finalBudget !== undefined) {
      if (!evidenceBudget?.reserveBytes(finalBudget.used))
        throw new RangeError(
          "Final semantic admission exceeded its reserved capacity",
        );
      const retainedFiles: JavaScriptSemanticFileCoverage[] = [];
      for (const coverage of files) {
        yield;
        const key = `${coverage.artifact_sha256}\u0000${coverage.module_path}`;
        const lost =
          (measured.get(key)?.facts ?? 0) < (before.get(key)?.facts ?? 0);
        if (lost && coverage.status === "unavailable")
          unavailableBudgetTruncatedFiles += 1;
        const updated = {
          ...coverage,
          retained_graph_bytes: measured.get(key)?.bytes ?? 0,
          graph_byte_budget: coverage.graph_byte_budget,
          ...(lost ||
          (coverage.graph_byte_budget !== null &&
            (measured.get(key)?.bytes ?? 0) > coverage.graph_byte_budget)
            ? { final_shared_graph_byte_budget: finalBudget.limit }
            : {}),
          unknowns: coverage.unknowns.map((count) => ({
            ...count,
            retained:
              retainedUnknownCounts.get(
                `${key}\u0000${count.family}\u0000${count.reason}`,
              ) ?? 0,
            ...(lost ? { total: null } : {}),
          })),
          ...(lost
            ? {
                status:
                  coverage.status === "unavailable"
                    ? ("unavailable" as const)
                    : ("truncated" as const),
                omitted_nodes: null,
                omitted_relations: null,
                omitted_fingerprints: null,
              }
            : {}),
        };
        if (
          evidenceBudget?.reserveBytes(
            Buffer.byteLength(JSON.stringify(updated)) + 1,
          )
        )
          retainedFiles.push(updated);
        else omittedFiles += 1;
      }
      files.length = 0;
      for (const file of retainedFiles) files.push(file);
    } else {
      for (let index = 0; index < files.length; index++) {
        yield;
        const coverage = files[index];
        if (coverage !== undefined)
          files[index] = {
            ...coverage,
            retained_graph_bytes:
              measured.get(
                `${coverage.artifact_sha256}\u0000${coverage.module_path}`,
              )?.bytes ?? 0,
          };
      }
    }
    if (state.roots.size === 0) {
      if (fallback.roots.size === 0)
        addFallbackRoot(rootArtifactSha256, fallback);
      for (const context of fallback.evidenceContexts.contexts)
        state.evidenceContexts.adopt(context);
      for (const [id, node] of fallback.nodes) state.nodes.set(id, node);
      for (const id of fallback.roots) state.roots.add(id);
    }
    const relations = [...state.relations.values()];
    const unknowns = [...state.unknowns.values()];
    const unknownOmissions = [...state.unknownOmissions.values()];
    const unknownsDropped = unknownOmissions.length > 0;
    type Family = (typeof JAVASCRIPT_SEMANTIC_RELATION_FAMILIES)[number];
    const retainedByFamily = new Map<Family, number>();
    const unknownsByFamily = new Map<Family, number>();
    const omittedUnknownsByFamily = new Map<Family, number>();
    const unknownTotalsIncomplete = new Set<Family>();
    for (const relation of relations) {
      yield;
      const family = JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation.relation];
      retainedByFamily.set(family, (retainedByFamily.get(family) ?? 0) + 1);
    }
    for (const unknown of unknowns) {
      yield;
      unknownsByFamily.set(
        unknown.family,
        (unknownsByFamily.get(unknown.family) ?? 0) + 1,
      );
    }
    for (const coverage of files) {
      yield;
      for (const count of coverage.unknowns)
        if (count.total === null) unknownTotalsIncomplete.add(count.family);
        else
          omittedUnknownsByFamily.set(
            count.family,
            (omittedUnknownsByFamily.get(count.family) ?? 0) +
              count.total -
              count.retained,
          );
    }
    const truncatedFiles = files.filter(
      ({ status }) => status === "truncated",
    ).length;
    const exactNodes =
      unavailableFiles === 0 &&
      omittedFiles === 0 &&
      files.every(({ omitted_nodes }) => omitted_nodes !== null);
    const exactRelations =
      exactNodes &&
      files.every(({ omitted_relations: omitted }) => omitted !== null);
    const sortedFiles = [...files].sort(
      (left, right) =>
        compareUnicodeCodePoints(left.module_path, right.module_path) ||
        compareUnicodeCodePoints(left.artifact_sha256, right.artifact_sha256),
    );
    const unknownCeilingCoverage = unknownsDropped
      ? javaScriptSemanticCeilingCoverage(
          "unknowns",
          unknownCeiling,
          fileUnknownCeiling,
          unknownCeilingsReached,
        )
      : undefined;
    const nodeCeilingCoverage =
      nodeCeilingsReached.total || nodeCeilingsReached.perFile
        ? javaScriptSemanticCeilingCoverage(
            "nodes",
            capacities.totalNodes ?? null,
            capacities.fileNodes ?? null,
            nodeCeilingsReached,
          )
        : undefined;
    const graph = factory({
      schema: "JavaScriptSemanticRelationGraph",
      root_artifact_sha256: rootArtifactSha256,
      application_graph_id: applicationGraph.graph_id,
      root_node_ids: [...state.roots],
      evidence_contexts: state.evidenceContexts.contexts.filter(
        ({ context_id }) =>
          finalBudget === undefined ||
          finalBudget.references(context_id) ||
          fallback.evidenceContexts.contexts.some(
            (context) => context.context_id === context_id,
          ),
      ),
      nodes: [...state.nodes.values()],
      relations,
      // The input is transferred to the factory; `fingerprints` is cleared below.
      fingerprints: [...fingerprints],
      unknowns,
      coverage: {
        status:
          truncatedFiles > 0 ||
          unavailableFiles > 0 ||
          omittedFiles > 0 ||
          unknownsDropped
            ? "partial"
            : "unknown",
        truncated:
          truncatedFiles > 0 ||
          resourceTruncatedFiles > 0 ||
          unavailableBudgetTruncatedFiles > 0 ||
          omittedFiles > 0 ||
          nodeCeilingsReached.total ||
          nodeCeilingsReached.perFile ||
          unknownsDropped,
        ...(unknownsDropped
          ? { omitted_unknown_occurrences: unknownOmissions }
          : {}),
        omitted_nodes: exactNodes
          ? files.reduce(
              (total, { omitted_nodes: omitted }) => total + (omitted ?? 0),
              0,
            )
          : null,
        omitted_relations: exactRelations
          ? files.reduce(
              (total, { omitted_relations: omitted }) => total + (omitted ?? 0),
              0,
            )
          : null,
        limits: [
          ...executionLimits.values(),
          ...(unavailableBudgetTruncatedFiles > 0 ||
          omittedFiles > 0 ||
          files.some(
            (file) =>
              file.graph_byte_budget !== null ||
              file.final_shared_graph_byte_budget !== undefined,
          )
            ? budgetLimits
            : []),
          ...(nodeCeilingCoverage?.limits ?? []),
          ...(unknownCeilingCoverage?.limits ?? []),
        ],
        families: JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => ({
          family,
          status: semanticFamilyStatus(family),
          retained_relations: retainedByFamily.get(family) ?? 0,
          omitted_relations: truncatedFiles > 0 || !exactNodes ? null : 0,
          retained_unknowns: unknownsByFamily.get(family) ?? 0,
          omitted_unknowns:
            exactNodes && !unknownTotalsIncomplete.has(family)
              ? (omittedUnknownsByFamily.get(family) ?? 0)
              : null,
        })),
        ...(omittedFiles === 0 ? {} : { omitted_files: omittedFiles }),
        files: sortedFiles,
      },
      limitations: [
        ...(nodeCeilingCoverage === undefined
          ? []
          : [nodeCeilingCoverage.limitation]),
        ...(unknownCeilingCoverage === undefined
          ? []
          : [
              `${unknownCeilingCoverage.limitation} Omission coverage counts examined emission occurrences by family and reason, including repeats; it does not count unexamined source frontiers or distinct discarded identities.`,
            ]),
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
        ...(truncatedFiles > 0
          ? [
              "Sources whose semantic facts exceeded their serialized byte budget or a caller-selected node capacity keep a source-ordered prefix; coverage.files reports omitted counts only for examined facts; skipped totals remain null. Select one source with source_paths to give it the whole budget.",
            ]
          : []),
      ],
    });
    state.nodes.clear();
    state.relations.clear();
    state.unknowns.clear();
    state.unknownOmissions.clear();
    state.roots.clear();
    state.evidenceContexts.clear();
    fingerprints.length = 0;
    files.length = 0;
    return graph;
  };
  return {
    remainingFileCapacity: () => ({
      nodes: remainingFileNodeBudget(),
      unknowns: Math.min(
        fileUnknownCeiling,
        Math.max(0, unknownCeiling - state.unknowns.size),
      ),
    }),
    adoptFileProjection: (file, projection) => {
      const offered = remainingFileNodeBudget();
      const remainingUnknowns = unknownCeiling - state.unknowns.size;
      if (
        offered !== null &&
        projection.nodes.filter(({ node_id }) => !state.nodes.has(node_id))
          .length > offered
      )
        throw new RangeError(
          "Transferred semantic nodes exceed the offered node capacity",
        );
      const newUnknowns = projection.unknowns.filter(
        ({ unknown_id }) => !state.unknowns.has(unknown_id),
      );
      if (
        newUnknowns.length >
        Math.min(fileUnknownCeiling, unknownCeiling - state.unknowns.size)
      )
        throw new RangeError(
          "Transferred semantic unknowns exceed the offered tree capacity",
        );
      if (projection.nodesTruncated) noteNodeLimit(state.nodes.size);
      for (const omission of projection.omittedUnknownOccurrences ?? [])
        recordSemanticUnknownOmission(state, omission);
      for (const context of projection.evidenceContexts)
        state.evidenceContexts.adopt(context);
      for (const node of projection.nodes) state.nodes.set(node.node_id, node);
      for (const relation of projection.relations)
        state.relations.set(relation.relation_id, relation);
      for (const unknown of newUnknowns)
        state.unknowns.set(unknown.unknown_id, unknown);
      for (const root of projection.roots) state.roots.add(root);
      for (const fingerprint of projection.fingerprints)
        fingerprints.push(fingerprint);
      graphReservedBytes += projection.coverage.retained_graph_bytes;
      const coverage = fileCoverage(file, projection.coverage);
      if (
        evidenceBudget === undefined ||
        evidenceBudget.reserveBytes(
          Buffer.byteLength(JSON.stringify(coverage)) + 1,
        )
      ) {
        files.push(coverage);
        coverageReservedBytes +=
          Buffer.byteLength(JSON.stringify(coverage)) + 1;
      } else omittedFiles += 1;
      if ((projection.omittedUnknownOccurrences?.length ?? 0) > 0)
        noteSemanticCeilingReached(
          unknownCeilingsReached,
          remainingUnknowns,
          fileUnknownCeiling,
        );
    },
    recordUnavailableFile: (file, reason, limits, unknownReason) => {
      // Both full and incremental construction enter here. Metadata/native
      // processing gaps belong to the application graph, never JavaScript IR.
      if (file.kind !== "javascript") return;
      const nodesBefore = state.nodes.size;
      const retainedLimits = javaScriptAnalysisCoverageLimits(limits);
      // A new limit row is retained only with this file's admitted facts.
      const newLimits = unseenLimitRows(executionLimits, retainedLimits);
      const local = emptyState();
      const budget = new SemanticFileGraphBudget(
        evidenceBudget?.remainingBytes() ?? null,
        remainingFileNodeBudget(),
      );
      local.fileBudget = budget;
      const module = retainModuleRoot(local, file);
      const evidence = {
        ...observedSemanticEvidence(file, null),
        authority: "unknown" as const,
        state: "unknown" as const,
        confidence: "unknown" as const,
        coverage: partialApplicationCoverage(retainedLimits, null),
        limitations: [reason],
      };
      const unknowns = [];
      const omissions = [];
      const remainingUnknowns = unknownCeiling - state.unknowns.size;
      const allowedUnknowns = Math.max(
        0,
        Math.min(fileUnknownCeiling, remainingUnknowns),
      );
      for (const family of JAVASCRIPT_SEMANTIC_RELATION_FAMILIES) {
        if (local.unknowns.size >= allowedUnknowns) {
          omissions.push({ family, reason: unknownReason, occurrences: 1 });
          unknowns.push({
            family,
            reason: unknownReason,
            total: null,
            retained: 0,
          });
          continue;
        }
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
          local.evidenceContexts,
        );
        const retained = budget.admit(unknown, local.evidenceContexts);
        if (retained) local.unknowns.set(unknown.unknown_id, unknown);
        unknowns.push({
          family,
          reason: unknownReason,
          total: 1,
          retained: retained ? 1 : 0,
        });
      }
      const coverage: JavaScriptSemanticFileCoverage = {
        module_path: file.path,
        artifact_sha256: file.sha256,
        status: "unavailable",
        graph_byte_budget: budget.byteLimitReached ? budget.limit : null,
        retained_graph_bytes: budget.used,
        omitted_nodes: null,
        omitted_relations: null,
        omitted_fingerprints: null,
        unknowns,
      };
      const bytes =
        budget.used +
        Buffer.byteLength(JSON.stringify(coverage)) +
        1 +
        newLimits.bytes +
        Buffer.byteLength(JSON.stringify(omissions));
      if (evidenceBudget === undefined || evidenceBudget.reserveBytes(bytes)) {
        for (const [key, limit] of newLimits.rows)
          executionLimits.set(key, limit);
        for (const context of local.evidenceContexts.contexts)
          if (budget.references(context.context_id))
            state.evidenceContexts.adopt(context);
        for (const [id, node] of local.nodes) state.nodes.set(id, node);
        for (const [id, unknown] of local.unknowns)
          state.unknowns.set(id, unknown);
        for (const omission of omissions)
          recordSemanticUnknownOmission(state, omission);
        if (omissions.length > 0)
          noteSemanticCeilingReached(
            unknownCeilingsReached,
            remainingUnknowns,
            fileUnknownCeiling,
          );
        for (const id of local.roots) state.roots.add(id);
        files.push(coverage);
        graphReservedBytes += budget.used;
        coverageReservedBytes +=
          Buffer.byteLength(JSON.stringify(coverage)) + 1;
      } else omittedFiles += 1;
      unavailableFiles += 1;
      if (budget.byteLimitReached) unavailableBudgetTruncatedFiles += 1;
      if (budget.nodeLimitReached) noteNodeLimit(nodesBefore);
      if (unknownReason === "resource-limit" && retainedLimits.length > 0)
        resourceTruncatedFiles += 1;
    },
    projectFile: (file, ir, paths) => {
      const steps = projectSourceSteps(file, ir, paths);
      while (steps.next().done !== true);
    },
    projectFileSteps: projectSourceSteps,
    finish: (rootArtifactSha256, applicationGraph, budgetLimits) =>
      (() => {
        const steps = finishWithSteps(
          createJavaScriptSemanticGraph,
          rootArtifactSha256,
          applicationGraph,
          budgetLimits ?? [],
        );
        for (;;) {
          const step = steps.next();
          if (step.done) return step.value;
        }
      })(),
    finishImmutableSteps: (
      rootArtifactSha256,
      applicationGraph,
      budgetLimits,
    ): Generator<void, JavaScriptSemanticGraph> =>
      (function* () {
        return yield* yield* finishWithSteps(
          sealTransferredJavaScriptSemanticGraphSteps,
          rootArtifactSha256,
          applicationGraph,
          budgetLimits ?? [],
        );
      })(),
  };
};

/** Coverage limit rows not yet listed by the graph, and their serialized bytes. */
const unseenLimitRows = (
  listed: ReadonlyMap<string, ApplicationCoverage["limits"][number]>,
  limits: ApplicationCoverage["limits"],
) => {
  const rows = new Map<string, ApplicationCoverage["limits"][number]>();
  let bytes = 0;
  for (const limit of limits) {
    const key = JSON.stringify([limit.name, limit.value, limit.unit]);
    if (listed.has(key) || rows.has(key)) continue;
    rows.set(key, limit);
    bytes += Buffer.byteLength(JSON.stringify(limit)) + 1;
  }
  return { rows, bytes };
};

/** Admit the module root that every projected or unavailable source starts with. */
const retainModuleRoot = (
  state: BuilderState,
  file: JavaScriptArtifactFile,
): JavaScriptSemanticGraphNode | null => {
  const module = retainNode(state, file, {
    kind: "module",
    roleKey: "module",
    location: null,
    label: file.path,
    functionNodeId: null,
  });
  if (module !== null) state.roots.add(module.node_id);
  return module;
};

/**
 * Serialized bytes of a source's module root and its evidence context, which
 * projection admits before any fact regardless of source length.
 */
export const semanticModuleRootBytes = (
  file: JavaScriptArtifactFile,
): number => {
  const state = emptyState();
  const budget = new SemanticFileGraphBudget(null);
  state.fileBudget = budget;
  retainModuleRoot(state, file);
  return budget.used;
};

const fileCoverage = (
  file: JavaScriptArtifactFile,
  coverage: JavaScriptSemanticFileProjectionCoverage,
): JavaScriptSemanticFileCoverage => ({
  module_path: file.path,
  artifact_sha256: file.sha256,
  ...coverage,
});

/**
 * Project one source within the offered serialized-byte budget and
 * caller-selected node capacity (null: unbounded), retaining no full IR.
 */
export function* projectJavaScriptSemanticFileSteps(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  graphByteBudget: number | null,
  capacity: JavaScriptSemanticProjectionCapacity,
  paths: readonly ElectronCallPath[] = [],
): Generator<void, JavaScriptSemanticFileProjection> {
  if (
    [capacity.nodes, capacity.unknowns].some(
      (value) =>
        value !== null &&
        (!Number.isSafeInteger(value) ||
          value < 0 ||
          value > JAVASCRIPT_SEMANTIC_ITEM_MAXIMUM),
    )
  )
    throw new RangeError(
      "File semantic projection requires valid offered retained capacities",
    );
  const state = emptyState();
  state.unknownCapacity = capacity.unknowns;
  const budget = new SemanticFileGraphBudget(graphByteBudget, capacity.nodes);
  const projected = yield* projectBudgetedFileSteps(
    file,
    ir,
    state,
    budget,
    paths,
  );
  return {
    roots: [...state.roots],
    // Refused facts may have interned provenance that no retained fact uses.
    evidenceContexts: state.evidenceContexts.contexts.filter(({ context_id }) =>
      budget.references(context_id),
    ),
    nodes: [...state.nodes.values()],
    relations: [...state.relations.values()],
    unknowns: [...state.unknowns.values()],
    fingerprints: projected.fingerprints,
    coverage: projected.coverage,
    nodesTruncated: budget.nodeLimitReached,
    ...(state.unknownOmissions.size > 0
      ? { omittedUnknownOccurrences: [...state.unknownOmissions.values()] }
      : {}),
  };
}

/** Project one file, then offer its fingerprints and deferred unknown frontiers. */
function* projectBudgetedFileSteps(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  state: BuilderState,
  budget: SemanticFileGraphBudget,
  paths: readonly ElectronCallPath[],
): Generator<
  void,
  {
    readonly fingerprints: JavaScriptSemanticFingerprint[];
    readonly coverage: JavaScriptSemanticFileProjectionCoverage;
  }
> {
  state.fileBudget = budget;
  try {
    const steps = projectFileSteps(file, ir, state, paths);
    let step = steps.next();
    while (!step.done && !budget.closed) {
      yield;
      step = steps.next();
    }
    const candidates = step.done ? step.value : [];
    if (!step.done) steps.return([]);
    if (budget.closed) budget.markIncomplete();
    return finishSemanticFileBudget(state, budget, candidates);
  } finally {
    delete state.fileBudget;
  }
}

function* projectFileSteps(
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  state: BuilderState,
  paths: readonly ElectronCallPath[],
): Generator<void, JavaScriptSemanticFingerprint[]> {
  yield;
  const moduleNode = retainModuleRoot(state, file);
  if (moduleNode === null) return [];
  projectFileResourceLimits({ file, ir, state, moduleNode });
  for (const location of ir.coverage.widenedReturnedReferences ?? [])
    addSemanticGraphUnknown(state, {
      node_id: moduleNode.node_id,
      family: "data-flow",
      relation_kinds: ["defines"],
      reason: "dynamic-property",
      detail: RETURNED_REFERENCE_WIDENING_LIMITATION,
      candidate_node_ids: [],
      evidence: {
        ...unknownSemanticEvidence(file, location),
        limitations: [RETURNED_REFERENCE_WIDENING_LIMITATION],
      },
    });
  yield* projectElectronSemanticCallPaths(file, paths, state);
  // Node creation keeps source order, which the per-file byte budget relies
  // on; yields between nodes do not change it.
  const callableNodes = new Map<string, JavaScriptSemanticGraphNode>();
  const fingerprintsByCallable = new Map(
    ir.functionFingerprints.map((fingerprint) => [
      fingerprint.callableId,
      fingerprint,
    ]),
  );
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
    if (node !== null) {
      const fingerprint = fingerprintsByCallable.get(callable.callableId);
      const projected =
        fingerprint === undefined
          ? undefined
          : projectSemanticFunctionFingerprint(
              file,
              fingerprint,
              node,
              state.evidenceContexts,
            );
      if (
        projected === undefined ||
        admitSemanticIndexedFingerprint(state, projected)
      )
        callableNodes.set(callable.callableId, node);
    }
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
    if (node !== null) {
      bindingNodes.set(binding.bindingId, node);
      // Offer each definition and its binding before staging the next binding.
      for (const [
        definitionIndex,
        definition,
      ] of binding.definitions.entries()) {
        const definitionNode = retainNode(state, file, {
          kind: "expression",
          roleKey: `definition:${binding.bindingId}:${String(definitionIndex)}`,
          location: definition.location,
          label: definition.kind,
          functionNodeId: node.function_node_id,
        });
        addRelation(state, {
          source: definitionNode,
          target: node,
          relation: "defines",
          resolution: "resolved",
        });
        if (state.fileBudget?.closed === true) break;
      }
    }
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
    readNodes: [],
    writeNodes: [],
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
  if (state.fileBudget !== undefined) return [];
  return projectSemanticFunctionFingerprints(
    file,
    ir,
    callableNodes,
    state.evidenceContexts,
  );
}

const projectFileResourceLimits = (
  context: Pick<FileContext, "file" | "ir" | "state" | "moduleNode">,
): void => {
  // Query limits describe effects without tagged values; other limits
  // already project from binding or return-site values and must not be duplicated.
  for (const limit of semanticCoverageResourceLimits(context.ir.coverage)) {
    if (limit !== "getter-expansion" && limit !== "alias-selections") continue;
    addSemanticGraphUnknown(context.state, {
      node_id: context.moduleNode.node_id,
      family: "data-flow",
      relation_kinds: ["defines"],
      reason: "resource-limit",
      detail: semanticResourceLimitReason(limit),
      candidate_node_ids: [],
      evidence: {
        ...unknownSemanticEvidence(context.file, null),
        coverage: partialApplicationCoverage(
          semanticResourceLimitCoverage([limit]),
          null,
        ),
        limitations: [semanticResourceLimitReason(limit)],
      },
    });
  }
};

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
    const nodeInput = {
      kind: "call-site" as const,
      roleKey: `call:${call.callSiteId}`,
      location: call.location,
      label: call.kind,
      functionNodeId: owner,
    };
    // Include the complete node and worker JSON envelope before retaining any
    // arguments. Each entry is charged by its encoded size and comma, so even
    // worst-case escaping cannot overflow the worker's single-record ceiling.
    let recordBytes = 0;
    if (call.arguments.some((argument) => Object.hasOwn(argument, "literal"))) {
      const baseline = constructSemanticGraphNode(file, nodeInput, state);
      recordBytes = Buffer.byteLength(
        `${JSON.stringify({ kind: "node", value: { ...baseline, properties: { arguments: [] } } })}\n`,
      );
    }
    const argumentsValue: JsonValue[] = [];
    let transferOmitted = 0;
    for (const argument of call.arguments) {
      if (!Object.hasOwn(argument, "literal")) continue;
      const item = {
        index: argument.index,
        value: argument.literal ?? null,
        source_range:
          argument.valueExpressionLocation === null
            ? null
            : {
                start: { ...argument.valueExpressionLocation.start },
                end: { ...argument.valueExpressionLocation.end },
              },
      };
      const size =
        Buffer.byteLength(JSON.stringify(item)) +
        (argumentsValue.length === 0 ? 0 : 1);
      if (recordBytes + size > JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES) {
        transferOmitted += 1;
        continue;
      }
      argumentsValue.push(item);
      recordBytes += size;
    }
    const node = retainNode(state, file, {
      ...nodeInput,
      ...(argumentsValue.length === 0
        ? {}
        : { properties: { arguments: argumentsValue } }),
    });
    if (node !== null) {
      result.set(call.callSiteId, node);
      // Callee identities are already indexed; admit each call with its endpoints now.
      for (const callableId of call.calleeCallableIds)
        addRelation(state, {
          source: node,
          target: callables.get(callableId),
          relation: "calls",
          resolution: call.resolution === "exact" ? "resolved" : "candidate",
        });
      if (transferOmitted > 0) {
        const detail = `${String(transferOmitted)} direct call arguments exceeded the ${String(JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES)}-byte worker transfer record ceiling.`;
        addSemanticGraphUnknown(state, {
          node_id: node.node_id,
          family: "call-flow",
          relation_kinds: ["argument-to-parameter"],
          reason: "resource-limit",
          detail,
          candidate_node_ids: [],
          evidence: {
            ...unknownSemanticEvidence(file, call.location),
            coverage: partialApplicationCoverage(
              javaScriptAnalysisCoverageLimits({
                transfer_record_bytes:
                  JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES,
              }),
              null,
            ),
            limitations: [detail],
          },
        });
      }
      if (
        call.arguments.some(
          (argument) => argument.literalResourceLimit === "primitive-bytes",
        )
      ) {
        const limit = "primitive-bytes";
        addSemanticGraphUnknown(state, {
          node_id: node.node_id,
          family: "call-flow",
          relation_kinds: ["argument-to-parameter"],
          reason: "resource-limit",
          detail: semanticResourceLimitReason(limit),
          candidate_node_ids: [],
          evidence: {
            ...unknownSemanticEvidence(file, call.location),
            coverage: partialApplicationCoverage(
              semanticResourceLimitCoverage([limit]),
              null,
            ),
            limitations: [semanticResourceLimitReason(limit)],
          },
        });
      }
    }
  }
  return result;
}

function* projectDefinitionsAndReferences(
  context: Omit<FileContext, "referenceNodesWithin">,
): Generator<void, void> {
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
    if (expression !== null) {
      context.referenceNodes.push(expression);
      if (reference.role === "read") context.readNodes.push(expression);
      if (reference.role === "write") context.writeNodes.push(expression);
    }
    if (binding === undefined || expression === null) continue;
    if (reference.role === "read")
      addRelation(context.state, {
        source: binding,
        target: expression,
        relation: "reads",
        resolution: "resolved",
        evidence: inferredSemanticEvidenceAt(context.file, reference.location),
      });
    else if (reference.role === "write")
      addRelation(context.state, {
        source: expression,
        target: binding,
        relation: "writes",
        resolution: "resolved",
      });
  }
}

const projectCalls = (context: FileContext): void => {
  const expressions = new Set(
    context.ir.expressionFlows.map((flow) =>
      javascriptSourceRangeKey(flow.location),
    ),
  );
  for (const call of context.ir.callSites) {
    const callNode = context.callSiteNodes.get(call.callSiteId);
    if (callNode === undefined) continue;
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
      if (!argument.spread && Object.hasOwn(argument, "literal"))
        addRelation(context.state, {
          source: argumentNode,
          target: callNode,
          relation: "influences",
          resolution: "resolved",
        });
      if (
        call.resolution !== "exact" &&
        call.resultUsed &&
        argumentNode !== null
      )
        addSemanticGraphUnknown(context.state, {
          node_id: argumentNode.node_id,
          family: "data-flow",
          relation_kinds: ["influences"],
          reason: "dynamic-call",
          detail:
            "The dynamic call's return dependency on this argument is unknown.",
          candidate_node_ids: [],
          evidence: unknownSemanticEvidence(context.file, argument.location),
        });
      const references =
        argument.valueExpressionLocation !== null &&
        expressions.has(
          javascriptSourceRangeKey(argument.valueExpressionLocation),
        )
          ? []
          : context
              .referenceNodesWithin(argument.location)
              .filter(
                (reference) =>
                  reference.function_node_id === callNode.function_node_id,
              );
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
      addRelation(context.state, {
        source: semanticObjectReadOccurrence(
          context,
          argument.valueExpressionLocation,
        ),
        target: argumentNode,
        relation: "aliases",
        resolution: "resolved",
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
  const returnFlowsByCallSite = new Map<
    string,
    JavaScriptSemanticCallReturnFlow[]
  >();
  for (const flow of context.ir.callReturnFlows) {
    const grouped = returnFlowsByCallSite.get(flow.callSiteId);
    if (grouped === undefined)
      returnFlowsByCallSite.set(flow.callSiteId, [flow]);
    else grouped.push(flow);
    addRelation(context.state, {
      source: context.returnSiteNodes.get(flow.returnSiteId),
      target: context.callSiteNodes.get(flow.callSiteId),
      relation: "returns-to-call",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  }
  for (const flow of context.ir.callResultFlows) {
    const resolution =
      context.callResolutions.get(flow.callSiteId) ?? "candidate";
    const target = context.bindingNodes.get(flow.bindingId);
    const returns = returnFlowsByCallSite.get(flow.callSiteId) ?? [];
    // A literal argument may influence the invocation. The assigned value
    // comes from modeled returns, so an ignored parameter does not reach it.
    if (returns.length === 0) {
      addRelation(context.state, {
        source: context.callSiteNodes.get(flow.callSiteId),
        target,
        relation: "aliases",
        resolution,
      });
      continue;
    }
    for (const item of returns)
      addRelation(context.state, {
        source: context.returnSiteNodes.get(item.returnSiteId),
        target,
        relation: "aliases",
        resolution,
      });
  }
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
    ...(!argument.spread && Object.hasOwn(argument, "literal")
      ? {
          properties: {
            literal_argument_value: argument.literal ?? null,
            literal_argument_call_site_node_id: callNode.node_id,
          },
        }
      : {}),
  });

/** Per-file projection passes, run in this order with a yield between each. */
const FILE_PROJECTION_PASSES: readonly ((
  context: FileContext,
) => Iterator<void, void> | void)[] = [
  projectSemanticValues,
  projectSemanticObjects,
  projectSemanticAssignments,
  projectCalls,
  projectSemanticExpressionInfluence,
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
