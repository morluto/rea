import { compareCodePoints } from "./javascriptApplicationGraph.js";
import type { JavaScriptSemanticGraph } from "./javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphUnknown } from "./javascriptSemanticGraphSchemas.js";
import type { JavaScriptSemanticQueryResult } from "./javascriptSemanticQuerySchemas.js";

/** One caller-limit frontier retained by deterministic query traversal. */
export interface JavaScriptSemanticQueryFrontier {
  readonly node_id: string;
  readonly depth: number;
  readonly reason:
    | "max-depth"
    | "max-edges"
    | "max-functions"
    | "max-modules"
    | "max-nodes"
    | "max-seed-matches";
}

/** Inputs needed to classify one completed semantic traversal. */
export interface JavaScriptSemanticQueryAssessmentInput {
  readonly graph: JavaScriptSemanticGraph;
  readonly totalSeeds: number;
  readonly retainedSeeds: number;
  readonly expectedMatches: number;
  readonly hasExpectation: boolean;
  readonly frontier: readonly JavaScriptSemanticQueryFrontier[];
  readonly unknowns: readonly JavaScriptSemanticGraphUnknown[];
  readonly candidateRelations: number;
  readonly unknownsTruncated: boolean;
}

/** Status, coverage, limits, and limitations derived from one traversal. */
export interface JavaScriptSemanticQueryAssessment {
  readonly status: JavaScriptSemanticQueryResult["status"];
  readonly coverage: JavaScriptSemanticQueryResult["coverage"];
  readonly limitations: string[];
  readonly acceptedLimitRanges: JavaScriptSemanticQueryResult["accepted_limit_ranges"];
}

/** Classify a bounded semantic traversal without promoting unknowns to absence. */
export const assessJavaScriptSemanticQuery = (
  input: JavaScriptSemanticQueryAssessmentInput,
): JavaScriptSemanticQueryAssessment => ({
  status: queryStatus(input),
  coverage: queryCoverage(input),
  limitations: queryLimitations(input),
  acceptedLimitRanges: {
    max_seed_matches: { minimum: 1, maximum: 1_000 },
    max_nodes: { minimum: 1, maximum: 50_000 },
    max_edges: { minimum: 1, maximum: 100_000 },
    max_depth: { minimum: 0, maximum: 64 },
    max_functions: { minimum: 1, maximum: 10_000 },
    max_modules: { minimum: 1, maximum: 10_000 },
    max_unknowns: { minimum: 0, maximum: 10_000 },
    page_size: { minimum: 1, maximum: 1_000 },
  },
});

const queryCoverage = (
  input: JavaScriptSemanticQueryAssessmentInput,
): JavaScriptSemanticQueryResult["coverage"] => ({
  status:
    input.graph.coverage.status === "unavailable"
      ? "unavailable"
      : input.frontier.length > 0 || input.unknownsTruncated
        ? "truncated"
        : input.unknowns.length > 0 ||
            input.candidateRelations > 0 ||
            input.graph.coverage.status !== "complete"
          ? "partial"
          : "complete",
  frontier: [...input.frontier],
});

const queryStatus = (
  input: JavaScriptSemanticQueryAssessmentInput,
): JavaScriptSemanticQueryResult["status"] => {
  if (input.graph.coverage.status === "unavailable") return "unsupported";
  if (input.frontier.length > 0 || input.unknownsTruncated) return "truncated";
  if (input.candidateRelations > 0) return "ambiguous";
  if (
    input.totalSeeds === 0 ||
    (input.hasExpectation && input.expectedMatches === 0)
  )
    return input.unknowns.length > 0 ||
      input.graph.coverage.status !== "complete"
      ? "partial"
      : "no-match";
  return input.totalSeeds > 1 ? "ambiguous" : "found";
};

const queryLimitations = (
  input: JavaScriptSemanticQueryAssessmentInput,
): string[] =>
  uniqueSorted([
    "Semantic graph reachability is a static inference and does not prove runtime execution.",
    ...input.graph.limitations,
    ...(input.totalSeeds === input.retainedSeeds
      ? []
      : [
          "Seed matches exceeded caller bounds; omitted starts remain unexplored.",
        ]),
    ...(input.frontier.length === 0
      ? []
      : [
          "Traversal stopped at explicit caller limits; frontier facts remain unknown.",
        ]),
    ...(input.unknowns.length === 0
      ? []
      : [
          "Relevant dynamic, unsupported, incomplete, or ambiguous semantics remain unknown.",
        ]),
    ...(input.unknownsTruncated
      ? [
          "Relevant unknown frontiers exceeded the caller limit; omitted unknowns remain unresolved.",
        ]
      : []),
    ...(input.candidateRelations === 0
      ? []
      : [
          "Candidate relations remain ambiguous and do not establish a resolved semantic path.",
        ]),
  ]);

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodePoints);
