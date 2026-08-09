import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import type { HistoricalSourceGraph } from "./referenceSourceGraph.js";
import {
  SOURCE_TO_BUNDLE_SIGNAL_WEIGHTS,
  sourceToBundleComparisonResultSchema,
  type CompareSourceToBundleInput,
  type SourceToBundleCandidate,
  type SourceToBundleComparisonItem,
  type SourceToBundleComparisonResult,
} from "./sourceToBundleComparisonSchemas.js";
import {
  buildSourceToBundleCandidateIndex,
  candidateIdsForSource,
  historicalSourceFiles,
  scoreSourceToBundleCandidate,
  sourceBearingNodes,
  type SourceToBundleCandidateIndex,
} from "./sourceToBundleSignals.js";

interface SourceToBundleComparisonInput {
  readonly reference: HistoricalSourceGraph;
  readonly application: {
    readonly evidenceId: string;
    readonly rootArtifactSha256: string;
    readonly graph: JavaScriptApplicationGraph;
  };
  readonly limits: CompareSourceToBundleInput["limits"];
}

interface ClassifiedMapping {
  readonly status: SourceToBundleComparisonItem["status"];
  readonly confidence: SourceToBundleComparisonItem["confidence"];
  readonly currentNodeIds: string[];
  readonly limitations: string[];
}

interface ComparisonProjection {
  readonly sources: ReturnType<typeof historicalSourceFiles>;
  readonly currentNodes: ReturnType<typeof sourceBearingNodes>;
  readonly index: SourceToBundleCandidateIndex;
  readonly absenceComplete: boolean;
  readonly factors: CoverageFactors;
}

interface MappingProjection {
  readonly items: SourceToBundleComparisonItem[];
  readonly candidateEvaluations: number;
  readonly omittedCandidateEvaluations: number;
  readonly omittedCandidateReferences: number;
}

/** Compare historical source files to static source-bearing application nodes. */
export const compareSourceToBundle = (
  input: SourceToBundleComparisonInput,
): SourceToBundleComparisonResult => {
  const projection = projectComparison(input);
  const mappings = compareMappings(input, projection);
  const factors = {
    ...projection.factors,
    omittedCandidateEvaluations: mappings.omittedCandidateEvaluations,
    omittedCandidateReferences: mappings.omittedCandidateReferences,
  };
  const mappedCurrentIds = new Set(
    mappings.items.flatMap(({ current_node_ids: nodeIds }) => nodeIds),
  );
  const unmappedCurrentNodeIds = projection.currentNodes
    .map(({ node_id: nodeId }) => nodeId)
    .filter((nodeId) => !mappedCurrentIds.has(nodeId));
  const semanticResult = {
    schema_version: 1 as const,
    reference: {
      root_sha256: input.reference.root_sha256,
      inventory_state: input.reference.inventory_state,
    },
    application: {
      evidence_id: input.application.evidenceId,
      graph_id: input.application.graph.graph_id,
      root_artifact_sha256: input.application.rootArtifactSha256,
    },
    scoring: scoringModel(),
    summary: comparisonSummary(mappings.items),
    items: mappings.items,
    unmapped_current_node_ids: unmappedCurrentNodeIds,
    coverage: comparisonCoverage(projection, mappings, factors),
    evidence_links: [input.application.evidenceId],
    limitations: comparisonLimitations(factors),
  };
  return sourceToBundleComparisonResultSchema.parse({
    ...semanticResult,
    comparison_id: `stbc_${digestCanonical(semanticResult)}`,
  });
};

const projectComparison = (
  input: SourceToBundleComparisonInput,
): ComparisonProjection => {
  const allSources = historicalSourceFiles(input.reference);
  const allCurrentNodes = sourceBearingNodes(input.application.graph.nodes);
  const sources = allSources.slice(0, input.limits.max_source_files);
  const currentNodes = allCurrentNodes.slice(
    0,
    input.limits.max_application_nodes,
  );
  const omittedSourceFiles = allSources.length - sources.length;
  const omittedApplicationNodes = allCurrentNodes.length - currentNodes.length;
  const index = buildSourceToBundleCandidateIndex(currentNodes);
  return {
    sources,
    currentNodes,
    index,
    absenceComplete:
      input.reference.inventory_state === "complete" &&
      input.application.graph.coverage.status === "complete" &&
      !input.application.graph.coverage.truncated &&
      omittedSourceFiles === 0 &&
      omittedApplicationNodes === 0 &&
      !index.pathIndexTruncated,
    factors: {
      input,
      omittedSourceFiles,
      omittedApplicationNodes,
      omittedCandidateEvaluations: 0,
      omittedCandidateReferences: 0,
      pathIndexTruncated: index.pathIndexTruncated,
    },
  };
};

const compareMappings = (
  input: SourceToBundleComparisonInput,
  projection: ComparisonProjection,
): MappingProjection => {
  let evaluationsRemaining = input.limits.max_candidate_evaluations;
  let candidateEvaluations = 0;
  let omittedCandidateEvaluations = 0;
  let omittedCandidateReferences = 0;
  const provisionalItems: SourceToBundleComparisonItem[] = [];
  for (const source of projection.sources) {
    const candidateIds = candidateIdsForSource(source, projection.index);
    const retainedIds = candidateIds.slice(0, evaluationsRemaining);
    const omittedEvaluations = candidateIds.length - retainedIds.length;
    evaluationsRemaining -= retainedIds.length;
    candidateEvaluations += retainedIds.length;
    omittedCandidateEvaluations += omittedEvaluations;
    const scored = retainedIds
      .map((nodeId) =>
        scoreSourceToBundleCandidate(source, nodeId, projection.index),
      )
      .filter(
        (candidate): candidate is SourceToBundleCandidate => candidate !== null,
      )
      .sort(compareCandidates);
    const retainedCandidates = scored.slice(
      0,
      input.limits.max_candidate_nodes,
    );
    const omittedCandidates =
      omittedEvaluations + scored.length - retainedCandidates.length;
    omittedCandidateReferences += omittedCandidates;
    const classification = classifyMapping(
      retainedCandidates,
      omittedCandidates === 0,
      projection.absenceComplete,
    );
    const semantic = {
      source_path: source.path,
      source_sha256: source.sha256,
      source_language: source.language,
      status: classification.status,
      confidence: classification.confidence,
      current_node_ids: classification.currentNodeIds,
      candidates: retainedCandidates,
      omitted_candidates: omittedCandidates,
      limitations: uniqueSorted([
        ...source.limitations,
        ...classification.limitations,
        ...(omittedCandidates > 0
          ? [
              `${String(omittedCandidates)} candidate references were omitted by comparison limits.`,
            ]
          : []),
      ]),
    };
    provisionalItems.push({
      mapping_id: mappingId(input, semantic),
      ...semantic,
    });
  }
  return {
    items: markMergedMappings(input, provisionalItems),
    candidateEvaluations,
    omittedCandidateEvaluations,
    omittedCandidateReferences,
  };
};

const comparisonCoverage = (
  projection: ComparisonProjection,
  mappings: MappingProjection,
  factors: CoverageFactors,
): SourceToBundleComparisonResult["coverage"] => ({
  status: coverageStatus(factors),
  reference_inventory_state: factors.input.reference.inventory_state,
  application_graph_status: factors.input.application.graph.coverage.status,
  retained_source_files: projection.sources.length,
  omitted_source_files: factors.omittedSourceFiles,
  retained_application_nodes: projection.currentNodes.length,
  omitted_application_nodes: factors.omittedApplicationNodes,
  candidate_evaluations: mappings.candidateEvaluations,
  omitted_candidate_evaluations: mappings.omittedCandidateEvaluations,
  omitted_candidate_references: mappings.omittedCandidateReferences,
  omitted_unmapped_current_nodes: 0,
});

const scoringModel = (): SourceToBundleComparisonResult["scoring"] => ({
  algorithm: "rea-source-to-bundle-signals/v1",
  minimum_candidate_score: 20,
  weights: SOURCE_TO_BUNDLE_SIGNAL_WEIGHTS.map(([signal, weight]) => ({
    signal,
    weight,
  })),
});

const classifyMapping = (
  candidates: readonly SourceToBundleCandidate[],
  evaluationComplete: boolean,
  absenceComplete: boolean,
): ClassifiedMapping => {
  if (!evaluationComplete)
    return {
      status: "unknown",
      confidence: "unknown",
      currentNodeIds: [],
      limitations: [
        "Candidate evaluation stopped at the declared limit; a stronger match may be omitted.",
      ],
    };
  const exact = candidates.filter((candidate) =>
    hasSignal(candidate, "exact-source-digest"),
  );
  if (exact.length === 1)
    return {
      status: "unchanged",
      confidence: "exact",
      currentNodeIds: [exact[0]?.current_node_id ?? ""].filter(Boolean),
      limitations: [
        "Exact byte identity does not establish equivalent load context or runtime behavior.",
      ],
    };
  if (exact.length > 1)
    return {
      status: "duplicated",
      confidence: "exact",
      currentNodeIds: exact.map(({ current_node_id: nodeId }) => nodeId),
      limitations: [
        "The same historical source digest occurs in multiple current graph nodes.",
      ],
    };
  const pathCandidates = candidates.filter((candidate) =>
    candidate.signals.some(({ kind }) =>
      [
        "source-map-original-path",
        "current-path-exact",
        "current-path-suffix",
      ].includes(kind),
    ),
  );
  const topScore = pathCandidates[0]?.score;
  const topPathCandidates =
    topScore === undefined
      ? []
      : pathCandidates.filter(({ score }) => score === topScore);
  if (topPathCandidates.length === 1) {
    const candidate = topPathCandidates[0];
    return {
      status: "unknown",
      confidence: "unknown",
      currentNodeIds:
        candidate === undefined ? [] : [candidate.current_node_id],
      limitations: [
        "Location evidence links the source to the current node, but comparable source digests are unavailable.",
      ],
    };
  }
  if (topPathCandidates.length > 1)
    return {
      status: "split",
      confidence: "medium",
      currentNodeIds: topPathCandidates.map(
        ({ current_node_id: nodeId }) => nodeId,
      ),
      limitations: [
        "Multiple equally scored current nodes retain the historical source path; this is a static split inference, not runtime proof.",
      ],
    };
  if (candidates.length > 0)
    return {
      status: "unknown",
      confidence: "unknown",
      currentNodeIds: [],
      limitations: [
        "Only weak basename or extension signals were available; no mapping was forced.",
      ],
    };
  return absenceComplete
    ? {
        status: "removed",
        confidence: "high",
        currentNodeIds: [],
        limitations: [
          "No retained current node matched exact digest or path signals within complete static inventories.",
        ],
      }
    : {
        status: "unknown",
        confidence: "unknown",
        currentNodeIds: [],
        limitations: [
          "No candidate was observed, but incomplete input or graph coverage prevents a removal claim.",
        ],
      };
};

const markMergedMappings = (
  input: SourceToBundleComparisonInput,
  items: readonly SourceToBundleComparisonItem[],
): SourceToBundleComparisonItem[] => {
  const sourcesByNode = new Map<string, SourceToBundleComparisonItem[]>();
  for (const item of items) {
    if (item.status !== "unchanged" || item.current_node_ids.length !== 1)
      continue;
    const nodeId = item.current_node_ids[0];
    if (nodeId === undefined) continue;
    sourcesByNode.set(nodeId, [...(sourcesByNode.get(nodeId) ?? []), item]);
  }
  const mergedSources = new Set(
    [...sourcesByNode.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) => group.map(({ source_path: path }) => path)),
  );
  return items.map((item) => {
    if (!mergedSources.has(item.source_path)) return item;
    const { mapping_id: previousMappingId, ...base } = item;
    void previousMappingId;
    const semantic = {
      ...base,
      status: "merged" as const,
      confidence: "exact" as const,
      limitations: uniqueSorted([
        ...item.limitations,
        "Multiple historical source paths have exact digest identity with the same current graph node.",
      ]),
    };
    return { ...semantic, mapping_id: mappingId(input, semantic) };
  });
};

const mappingId = (
  input: SourceToBundleComparisonInput,
  item: Omit<SourceToBundleComparisonItem, "mapping_id">,
): string =>
  `stbc_item_${digestCanonical({
    reference_root_sha256: input.reference.root_sha256,
    application_graph_id: input.application.graph.graph_id,
    ...item,
  })}`;

const comparisonSummary = (
  items: readonly SourceToBundleComparisonItem[],
): SourceToBundleComparisonResult["summary"] => ({
  unchanged: countStatus(items, "unchanged"),
  modified: countStatus(items, "modified"),
  removed: countStatus(items, "removed"),
  split: countStatus(items, "split"),
  merged: countStatus(items, "merged"),
  duplicated: countStatus(items, "duplicated"),
  unknown: countStatus(items, "unknown"),
});

const countStatus = (
  items: readonly SourceToBundleComparisonItem[],
  status: SourceToBundleComparisonItem["status"],
): number => items.filter((item) => item.status === status).length;

interface CoverageFactors {
  readonly input: SourceToBundleComparisonInput;
  readonly omittedSourceFiles: number;
  readonly omittedApplicationNodes: number;
  readonly omittedCandidateEvaluations: number;
  readonly omittedCandidateReferences: number;
  readonly pathIndexTruncated: boolean;
}

const coverageStatus = (
  factors: CoverageFactors,
): SourceToBundleComparisonResult["coverage"]["status"] => {
  if (
    factors.omittedSourceFiles > 0 ||
    factors.omittedApplicationNodes > 0 ||
    factors.omittedCandidateEvaluations > 0 ||
    factors.omittedCandidateReferences > 0 ||
    factors.pathIndexTruncated
  )
    return "truncated";
  return factors.input.reference.inventory_state === "complete" &&
    factors.input.application.graph.coverage.status === "complete"
    ? "complete-within-inputs"
    : "partial";
};

const comparisonLimitations = (factors: CoverageFactors): string[] =>
  uniqueSorted([
    "Static digest and location signals do not establish runtime behavior, semantic equivalence, or absence of dynamically generated modules.",
    ...factors.input.reference.limitations,
    ...factors.input.application.graph.limitations,
    ...(factors.input.reference.inventory_state === "complete"
      ? []
      : [
          `Historical source inventory is ${factors.input.reference.inventory_state}; unmatched files remain unknown.`,
        ]),
    ...(factors.input.application.graph.coverage.status === "complete"
      ? []
      : [
          `Application graph coverage is ${factors.input.application.graph.coverage.status}; unmatched files remain unknown.`,
        ]),
    ...(factors.omittedSourceFiles > 0
      ? [
          `${String(factors.omittedSourceFiles)} historical source files were omitted by max_source_files.`,
        ]
      : []),
    ...(factors.omittedApplicationNodes > 0
      ? [
          `${String(factors.omittedApplicationNodes)} source-bearing application nodes were omitted by max_application_nodes.`,
        ]
      : []),
    ...(factors.omittedCandidateEvaluations > 0
      ? [
          `${String(factors.omittedCandidateEvaluations)} candidate evaluations were omitted by max_candidate_evaluations.`,
        ]
      : []),
    ...(factors.omittedCandidateReferences > 0
      ? [
          `${String(factors.omittedCandidateReferences)} candidate references were omitted from item output.`,
        ]
      : []),
    ...(factors.pathIndexTruncated
      ? [
          "At least one current path exceeded the 128-segment suffix index bound.",
        ]
      : []),
  ]);

const hasSignal = (
  candidate: SourceToBundleCandidate,
  kind: SourceToBundleCandidate["signals"][number]["kind"],
): boolean => candidate.signals.some((signal) => signal.kind === kind);

const compareCandidates = (
  left: SourceToBundleCandidate,
  right: SourceToBundleCandidate,
): number =>
  right.score - left.score ||
  compareText(left.current_node_id, right.current_node_id);

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Source-to-bundle comparison could not canonicalize");
  return createHash("sha256").update(encoded).digest("hex");
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
