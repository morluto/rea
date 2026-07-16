import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { Evidence } from "./evidence.js";
import { buildJavaScriptApplicationChangeGraph } from "./javascriptApplicationChangeGraph.js";
import {
  applicationVersionComparisonResultSchema,
  type ApplicationVersionComparisonResult,
  type CompareApplicationVersionsInput,
} from "./javascriptApplicationVersionComparisonSchemas.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { compareCodePoints } from "./javascriptApplicationGraph.js";
import { classifyJavaScriptApplicationVersions } from "./javascriptApplicationVersionItems.js";
import { matchJavaScriptApplicationVersions } from "./javascriptApplicationVersionKeys.js";

/** Pure inputs after application-layer Evidence authentication. */
export interface ApplicationVersionComparisonProjectionInput {
  readonly left: {
    readonly evidenceId: string;
    readonly rootArtifactSha256: string;
    readonly graph: JavaScriptApplicationGraph;
  };
  readonly right: {
    readonly evidenceId: string;
    readonly rootArtifactSha256: string;
    readonly graph: JavaScriptApplicationGraph;
  };
  readonly leftNativeEvidence: readonly Evidence[];
  readonly rightNativeEvidence: readonly Evidence[];
  readonly limits: CompareApplicationVersionsInput["limits"];
}

/** Compare application entities with ordered unique-only identity tiers. */
export const compareJavaScriptApplicationVersions = (
  input: ApplicationVersionComparisonProjectionInput,
): ApplicationVersionComparisonResult => {
  const matching = matchJavaScriptApplicationVersions(
    input.left.graph.nodes,
    input.right.graph.nodes,
  );
  const projection = classifyJavaScriptApplicationVersions(matching, {
    leftGraph: input.left.graph,
    rightGraph: input.right.graph,
    leftEvidenceId: input.left.evidenceId,
    rightEvidenceId: input.right.evidenceId,
    leftNativeEvidence: input.leftNativeEvidence,
    rightNativeEvidence: input.rightNativeEvidence,
    maxCandidates: input.limits.max_candidate_nodes,
  });
  const items = projection.items.slice(0, input.limits.max_comparison_items);
  const omittedComparisonItems = projection.items.length - items.length;
  const changeGraph = buildJavaScriptApplicationChangeGraph({
    left: input.left.graph,
    right: input.right.graph,
    leftEvidenceId: input.left.evidenceId,
    rightEvidenceId: input.right.evidenceId,
    items,
    omittedComparisonItems,
    limits: input.limits,
  });
  const evidenceLinks = uniqueSorted(
    projection.items.flatMap(({ evidence_links: links }) => links),
  );
  const omissions = {
    omitted_comparison_items: omittedComparisonItems,
    omitted_candidate_references: projection.omittedCandidateReferences,
    omitted_graph_nodes: changeGraph.omittedNodes,
    omitted_graph_edges: changeGraph.omittedEdges,
    omitted_graph_observations: changeGraph.omittedObservations,
  };
  const semantic = {
    schema_version: 1 as const,
    left: {
      evidence_id: input.left.evidenceId,
      graph_id: input.left.graph.graph_id,
      root_artifact_sha256: input.left.rootArtifactSha256,
    },
    right: {
      evidence_id: input.right.evidenceId,
      graph_id: input.right.graph.graph_id,
      root_artifact_sha256: input.right.rootArtifactSha256,
    },
    summary: summary(projection.items),
    matching: matchingSummary(projection.items),
    items,
    graph: changeGraph.graph,
    coverage: {
      status: comparisonCoverageStatus(input, omissions),
      left_graph_status: input.left.graph.coverage.status,
      right_graph_status: input.right.graph.coverage.status,
      ...omissions,
    },
    evidence_links: evidenceLinks,
    limitations: comparisonLimitations(input, omissions),
  };
  return applicationVersionComparisonResultSchema.parse({
    ...semantic,
    comparison_id: `javc_${digestCanonical(semantic)}`,
  });
};

const summary = (
  items: readonly ApplicationVersionComparisonResult["items"][number][],
): ApplicationVersionComparisonResult["summary"] => ({
  unchanged: countStatus(items, "unchanged"),
  added: countStatus(items, "added"),
  removed: countStatus(items, "removed"),
  changed: countStatus(items, "changed"),
  unknown: countStatus(items, "unknown"),
});

const countStatus = (
  items: readonly ApplicationVersionComparisonResult["items"][number][],
  status: ApplicationVersionComparisonResult["items"][number]["status"],
): number => items.filter((item) => item.status === status).length;

const matchingSummary = (
  items: readonly ApplicationVersionComparisonResult["items"][number][],
): ApplicationVersionComparisonResult["matching"] => ({
  exact_node_identity: countBasis(items, "exact-node-identity"),
  exact_content_digest: countBasis(items, "exact-content-digest"),
  exact_module_source_digest: countBasis(items, "exact-module-source-digest"),
  source_map_identity: countBasis(items, "source-map-identity"),
  structural_fingerprint: countBasis(items, "structural-fingerprint"),
  semantic_key: countBasis(items, "semantic-key"),
  ambiguous: items.filter(({ match }) => match.status === "ambiguous").length,
  unmatched: items.filter(({ match }) => match.status === "unmatched").length,
});

const countBasis = (
  items: readonly ApplicationVersionComparisonResult["items"][number][],
  basis: ApplicationVersionComparisonResult["items"][number]["match"]["basis"],
): number => items.filter(({ match }) => match.basis === basis).length;

type ComparisonOmissions = ApplicationVersionComparisonResult["coverage"];

const comparisonCoverageStatus = (
  input: ApplicationVersionComparisonProjectionInput,
  omissions: Omit<
    ComparisonOmissions,
    "status" | "left_graph_status" | "right_graph_status"
  >,
): ApplicationVersionComparisonResult["coverage"]["status"] =>
  Object.values(omissions).some((value) => value > 0)
    ? "truncated"
    : input.left.graph.coverage.status === "complete" &&
        input.right.graph.coverage.status === "complete"
      ? "complete-within-inputs"
      : "partial";

const comparisonLimitations = (
  input: ApplicationVersionComparisonProjectionInput,
  omissions: Omit<
    ComparisonOmissions,
    "status" | "left_graph_status" | "right_graph_status"
  >,
): string[] =>
  uniqueSorted([
    "Application comparison never uses bundler module ordinals as persistent identity and performs no fuzzy pairing.",
    "Exact digest equality proves byte identity only; source-map, structural-fingerprint, and semantic-key matches retain inferred confidence.",
    "Minified names and chunk locations are not assumed stable across versions.",
    "The comparison reads retained graphs and Evidence only; it does not execute either application.",
    "Native Evidence is linked only by exact subject digest; provider snapshot reuse remains target/provider/profile exact.",
    ...(input.left.graph.coverage.status === "complete" &&
    input.right.graph.coverage.status === "complete"
      ? []
      : [
          "At least one source graph is incomplete; unmatched entities on the opposite side remain unknown rather than added or removed.",
        ]),
    ...(Object.values(omissions).some((value) => value > 0)
      ? ["Comparison output was truncated at explicit caller limits."]
      : []),
  ]);

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "Application version comparison could not canonicalize data",
    );
  return createHash("sha256").update(encoded).digest("hex");
};

const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);
