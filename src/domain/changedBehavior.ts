import { z } from "zod";

import { artifactComparisonResultSchema } from "./artifactComparison.js";
import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import { functionComparisonResultSchema } from "./functionComparison.js";
import {
  comparisonStatusSchema,
  deriveProcessComparisonStatus,
  PROCESS_COMPARISON_DIMENSIONS,
  processCaptureComparisonSchema,
} from "./processCapture.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");

/** Input for aggregating existing comparison Evidence. */
export const changedBehaviorInputSchema = z.object({
  comparisons: z.array(evidenceSchema).default([]),
});

const findingSchema = z.object({
  scope: z.enum(["runtime", "protocol", "resource", "static_candidate"]),
  dimension: z.string().min(1),
  classification: z.enum([
    "observed_change",
    "derived_relationship",
    "contradiction",
    "unresolved_branch",
  ]),
  status: comparisonStatusSchema,
  source_comparison_id: evidenceIdSchema,
  evidence_links: z.array(evidenceIdSchema).min(3),
  limitations: z.array(z.string()),
});

/** Truthful aggregate: runtime observations remain separate from static candidates. */
export const changedBehaviorResultSchema = z
  .object({
    behavior_status: z.enum([
      "observed_changed",
      "observed_unchanged",
      "unknown",
      "truncated",
    ]),
    summary: z.object({
      observed_changes: z.number().int().min(0),
      static_candidates: z.number().int().min(0),
      contradictions: z.number().int().min(0),
      unresolved: z.number().int().min(0),
    }),
    findings: z.object({
      items: z.array(findingSchema),
    }),
    evidence_links: z.array(evidenceIdSchema).min(3),
    limitations: z.array(z.string()),
  })
  .superRefine((result, context) => {
    const summaryTotal = Object.values(result.summary).reduce(
      (total, count) => total + count,
      0,
    );
    if (summaryTotal !== result.findings.items.length)
      context.addIssue({
        code: "custom",
        message: "Finding classification counts must equal the finding total",
        path: ["summary"],
      });
    if (
      (result.behavior_status === "observed_changed" &&
        result.summary.observed_changes === 0) ||
      (result.behavior_status === "observed_unchanged" &&
        result.summary.observed_changes > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Observed-change status must agree with runtime findings",
        path: ["behavior_status"],
      });
  });

export type ChangedBehaviorResult = z.infer<typeof changedBehaviorResultSchema>;
type Finding = z.infer<typeof findingSchema>;
type RuntimeStatus = z.infer<typeof processCaptureComparisonSchema>["status"];

const EXPECTED_PROVIDERS = {
  compare_process_captures: {
    predicates: ["rea.process-comparison"],
    id: "rea-process",
    name: "REA deterministic process harness",
    version: "3",
  },
  compare_artifacts: {
    predicates: ["rea.artifact-comparison"],
    id: "rea-artifact-comparison",
    name: "REA artifact comparison",
    version: "1",
  },
  compare_functions: {
    predicates: ["rea.function-comparison"],
    id: "rea-function-comparison",
    name: "REA function comparison",
    version: "1",
  },
} as const;

const acceptsPredicate = (
  expected: readonly string[],
  actual: string,
): boolean => expected.some((predicate) => predicate === actual);

/** Find observed runtime changes and separately report static change candidates. */
export const findChangedBehavior = (
  comparisonsInput: unknown,
): ChangedBehaviorResult => {
  const parsedInput = changedBehaviorInputSchema.parse({
    comparisons: comparisonsInput,
  });
  const comparisons = parsedInput.comparisons;
  const evidence = comparisons.map(parseComparisonEvidence);
  assertUnique(
    evidence.map(({ evidence_id: id }) => id),
    "comparison Evidence",
  );
  const findings = evidence.flatMap(findingsFor).sort(compareFindings);
  const runtimeStatuses = evidence.flatMap(runtimeStatus);
  const links = uniqueSorted(
    evidence.flatMap((item) => [item.evidence_id, ...item.evidence_links]),
  );
  return changedBehaviorResultSchema.parse({
    behavior_status: behaviorStatus(runtimeStatuses),
    summary: {
      observed_changes: count(findings, "observed_change"),
      static_candidates: count(findings, "derived_relationship"),
      contradictions: count(findings, "contradiction"),
      unresolved: count(findings, "unresolved_branch"),
    },
    findings: {
      items: findings,
    },
    evidence_links: links,
    limitations: uniqueSorted([
      ...evidence.flatMap(({ limitations }) => limitations),
      ...(evidence.some(
        ({ operation }) => operation !== "compare_process_captures",
      )
        ? [
            "Static differences are behavior candidates, not runtime observations.",
          ]
        : []),
      ...(runtimeStatuses.length === 0
        ? ["No process comparison Evidence was supplied."]
        : []),
    ]),
  });
};

const parseComparisonEvidence = (input: unknown): Evidence => {
  const evidence = parseEvidence(input);
  if (!(evidence.operation in EXPECTED_PROVIDERS))
    throw new TypeError(
      "Changed-behavior analysis requires process, artifact, or function comparison Evidence",
    );
  const operation = z
    .enum([
      "compare_process_captures",
      "compare_artifacts",
      "compare_functions",
    ])
    .parse(evidence.operation);
  const expected = EXPECTED_PROVIDERS[operation];
  if (
    !acceptsPredicate(expected.predicates, evidence.predicate_type) ||
    evidence.provider.id !== expected.id ||
    evidence.provider.name !== expected.name ||
    evidence.provider.version !== expected.version ||
    evidence.confidence !== "derived" ||
    evidence.authority !== "analyst-inference" ||
    evidence.subject !== null
  )
    throw new TypeError(
      "Comparison Evidence operation, predicate, and provider disagree",
    );
  if (evidence.evidence_links.length < 2)
    throw new TypeError(
      "Comparison Evidence must cite both source observations",
    );
  assertUnique(evidence.evidence_links, "source Evidence links");
  parseResult(evidence);
  return evidence;
};

const parseResult = (evidence: Evidence): void => {
  if (evidence.operation === "compare_process_captures") {
    const result = processCaptureComparisonSchema.parse(
      evidence.normalized_result,
    );
    const expected = deriveProcessComparisonStatus(
      PROCESS_COMPARISON_DIMENSIONS.map((dimension) => result[dimension]),
    );
    if (result.status !== expected)
      throw new TypeError(
        "Process comparison status contradicts its dimensions",
      );
    return;
  }
  if (evidence.operation === "compare_functions") {
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    assertNestedLinks(
      evidence,
      result.dimensions.flatMap(({ evidence_links: links }) => links),
    );
    return;
  }
  const result = artifactComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  assertNestedLinks(
    evidence,
    result.changes.flatMap(({ evidence_links: links }) => links),
  );
};

const assertNestedLinks = (
  evidence: Evidence,
  nestedLinks: readonly string[],
): void => {
  const topLevel = new Set(evidence.evidence_links);
  if (nestedLinks.some((evidenceId) => !topLevel.has(evidenceId)))
    throw new TypeError(
      "Comparison finding cites Evidence outside its top-level closure",
    );
};

const findingsFor = (evidence: Evidence): Finding[] => {
  if (evidence.operation === "compare_process_captures")
    return processFindings(evidence);
  if (evidence.operation === "compare_functions")
    return functionFindings(evidence);
  return artifactFindings(evidence);
};

const processFindings = (evidence: Evidence): Finding[] => {
  const result = processCaptureComparisonSchema.parse(
    evidence.normalized_result,
  );
  const dimensions = [
    ["terminal", result.terminal, "runtime"],
    ["interaction", result.interaction, "runtime"],
    ["exit", result.exit, "runtime"],
    ["filesystem", result.filesystem, "resource"],
    ["process", result.process, "runtime"],
  ] as const;
  return dimensions.flatMap(([dimension, status, scope]) =>
    status === "unchanged"
      ? []
      : [
          makeFinding({
            evidence,
            dimension,
            scope,
            status,
            classification: isChange(status)
              ? "observed_change"
              : "unresolved_branch",
            limitations: result.limitations,
          }),
        ],
  );
};

const functionFindings = (evidence: Evidence): Finding[] => {
  const result = functionComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  return result.dimensions.flatMap((dimension) =>
    dimension.status === "unchanged"
      ? []
      : [
          makeFinding({
            evidence,
            dimension: dimension.dimension,
            scope: "static_candidate",
            status: dimension.status,
            classification:
              dimension.status === "unknown" || dimension.status === "truncated"
                ? "unresolved_branch"
                : dimension.conclusion_kind,
            limitations: dimension.limitations,
            links: dimension.evidence_links,
          }),
        ],
  );
};

const artifactFindings = (evidence: Evidence): Finding[] => {
  const result = artifactComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  const changes = result.changes.map((change) =>
    makeFinding({
      evidence,
      dimension: `artifact:${change.logical_path}`,
      scope: "static_candidate",
      status: change.classification,
      classification:
        change.classification === "contradiction"
          ? "contradiction"
          : change.classification === "unknown"
            ? "unresolved_branch"
            : "derived_relationship",
      limitations: result.limitations,
      links: change.evidence_links,
    }),
  );
  return (result.status === "unknown" || result.status === "truncated") &&
    !changes.some(
      ({ classification }) => classification === "unresolved_branch",
    )
    ? [
        ...changes,
        makeFinding({
          evidence,
          dimension: "artifact:coverage",
          scope: "static_candidate",
          status: result.status,
          classification: "unresolved_branch",
          limitations: result.limitations,
        }),
      ]
    : changes;
};

const makeFinding = (input: {
  readonly evidence: Evidence;
  readonly dimension: string;
  readonly scope: Finding["scope"];
  readonly status: Finding["status"];
  readonly classification: Finding["classification"];
  readonly limitations: readonly string[];
  readonly links?: readonly string[];
}): Finding =>
  findingSchema.parse({
    scope: input.scope,
    dimension: input.dimension,
    classification: input.classification,
    status: input.status,
    source_comparison_id: input.evidence.evidence_id,
    evidence_links: uniqueSorted([
      input.evidence.evidence_id,
      ...(input.links ?? input.evidence.evidence_links),
    ]),
    limitations: uniqueSorted(input.limitations),
  });

const runtimeStatus = (evidence: Evidence): RuntimeStatus[] =>
  evidence.operation === "compare_process_captures"
    ? [processCaptureComparisonSchema.parse(evidence.normalized_result).status]
    : [];

const behaviorStatus = (
  statuses: readonly RuntimeStatus[],
): ChangedBehaviorResult["behavior_status"] => {
  if (statuses.length === 0) return "unknown";
  if (statuses.includes("truncated")) return "truncated";
  if (statuses.includes("unknown")) return "unknown";
  return statuses.some(isChange) ? "observed_changed" : "observed_unchanged";
};

const isChange = (status: RuntimeStatus): boolean =>
  status === "added" || status === "removed" || status === "changed";

const count = (
  findings: readonly Finding[],
  classification: Finding["classification"],
): number =>
  findings.filter((finding) => finding.classification === classification)
    .length;

const compareFindings = (left: Finding, right: Finding): number =>
  [left.scope, left.dimension, left.source_comparison_id]
    .join("\0")
    .localeCompare(
      [right.scope, right.dimension, right.source_comparison_id].join("\0"),
      "en",
    );

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length)
    throw new TypeError(`Changed-behavior analysis rejects duplicate ${label}`);
};
