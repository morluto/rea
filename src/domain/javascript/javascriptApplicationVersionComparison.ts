import { digestCanonicalValue } from "../canonicalDigest.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import type { Evidence } from "../evidence.js";
import { joinCoverageStatus } from "../coverage.js";
import { applicationCoverageKnowledge } from "./javascriptApplicationEvidenceSchemas.js";
import { buildJavaScriptApplicationChangeGraph } from "./javascriptApplicationChangeGraph.js";
import {
  ownedApplicationVersionComparisonResultSchema,
  type ApplicationVersionComparisonResult,
} from "./javascriptApplicationVersionComparisonSchemas.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
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
  });
  const changeGraph = buildJavaScriptApplicationChangeGraph({
    left: input.left.graph,
    right: input.right.graph,
    leftEvidenceId: input.left.evidenceId,
    rightEvidenceId: input.right.evidenceId,
    items: projection.items,
  });
  const evidenceLinks = uniqueSorted(
    projection.items.flatMap(({ evidence_links: links }) => links),
  );
  const omissions = {
    left_graph_omitted_count: input.left.graph.coverage.omitted_count,
    right_graph_omitted_count: input.right.graph.coverage.omitted_count,
  };
  const coverage = comparisonCoverage(input, omissions);
  const semantic = {
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
    items: projection.items,
    graph: changeGraph.graph,
    coverage,
    evidence_links: evidenceLinks,
    limitations: comparisonLimitations(input),
  };
  return ownedApplicationVersionComparisonResultSchema.parse({
    ...semantic,
    comparison_id: `javc_${digestCanonicalValue(semantic, "Application version comparison")}`,
  });
};

const summary = (
  items: readonly ApplicationVersionComparisonResult["items"][number][],
): ApplicationVersionComparisonResult["summary"] => {
  const counts = {
    unchanged: 0,
    added: 0,
    removed: 0,
    changed: 0,
    unknown: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
};

const matchingSummary = (
  items: readonly ApplicationVersionComparisonResult["items"][number][],
): ApplicationVersionComparisonResult["matching"] => {
  const counts = {
    exact_node_identity: 0,
    exact_content_digest: 0,
    exact_module_source_digest: 0,
    source_map_identity: 0,
    structural_fingerprint: 0,
    semantic_key: 0,
    ambiguous: 0,
    unmatched: 0,
  };
  for (const { match } of items) {
    switch (match.basis) {
      case "exact-node-identity":
        counts.exact_node_identity += 1;
        break;
      case "exact-content-digest":
        counts.exact_content_digest += 1;
        break;
      case "exact-module-source-digest":
        counts.exact_module_source_digest += 1;
        break;
      case "source-map-identity":
        counts.source_map_identity += 1;
        break;
      case "structural-fingerprint":
        counts.structural_fingerprint += 1;
        break;
      case "semantic-key":
        counts.semantic_key += 1;
        break;
      case "none":
        // Ambiguous and unmatched items are counted by match status below.
        break;
    }
    if (match.status === "ambiguous") counts.ambiguous += 1;
    else if (match.status === "unmatched") counts.unmatched += 1;
  }
  return counts;
};

type ComparisonOmissions = ApplicationVersionComparisonResult["coverage"];
type ComparisonOmissionCounts = Pick<
  ComparisonOmissions,
  "left_graph_omitted_count" | "right_graph_omitted_count"
>;

const comparisonCoverage = (
  input: ApplicationVersionComparisonProjectionInput,
  omissions: ComparisonOmissionCounts,
): ApplicationVersionComparisonResult["coverage"] => {
  const context = {
    left_graph_status: input.left.graph.coverage.status,
    right_graph_status: input.right.graph.coverage.status,
  };
  const joined = joinCoverageStatus([
    applicationCoverageKnowledge(input.left.graph.coverage.status),
    applicationCoverageKnowledge(input.right.graph.coverage.status),
  ]);
  const sourceGraphsTruncated =
    input.left.graph.coverage.truncated || input.right.graph.coverage.truncated;
  return {
    ...context,
    ...omissions,
    status:
      joined === "complete"
        ? "complete-within-inputs"
        : joined === "unknown"
          ? "unknown"
          : sourceGraphsTruncated
            ? "truncated"
            : "partial",
  };
};

const comparisonLimitations = (
  input: ApplicationVersionComparisonProjectionInput,
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
  ]);
