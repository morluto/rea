import { z } from "zod";

import { artifactComparisonResultSchema } from "./artifactComparison.js";
import { uniqueSorted } from "./canonicalOrdering.js";
import {
  compositeKey,
  compareUnicodeCodePoints,
} from "./unicodeCodePointOrder.js";
import { comparisonSourceEvidenceIds } from "./comparisonSourceEvidence.js";
import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import { functionComparisonResultSchema } from "./functionComparisonSchemas.js";
import {
  PROCESS_PROVIDER,
  isProcessEvidenceProvider,
} from "./process/processEvidenceProvider.js";
import {
  comparisonStatusSchema,
  deriveProcessComparisonStatus,
  PROCESS_COMPARISON_DIMENSIONS,
  processCaptureComparisonSchema,
} from "./process/processComparison.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");

/** Input for aggregating existing comparison Evidence. */
export const changedBehaviorInputSchema = z.strictObject({
  comparisons: z.array(evidenceSchema).min(1),
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
  evidence_links: z.array(evidenceIdSchema).min(2),
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
    evidence_links: z.array(evidenceIdSchema).min(2),
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
type ParsedComparison =
  | {
      readonly operation: "compare_process_captures";
      readonly evidence: Evidence;
      readonly result: z.infer<typeof processCaptureComparisonSchema>;
    }
  | {
      readonly operation: "compare_functions";
      readonly evidence: Evidence;
      readonly result: z.infer<typeof functionComparisonResultSchema>;
    }
  | {
      readonly operation: "compare_artifacts";
      readonly evidence: Evidence;
      readonly result: z.infer<typeof artifactComparisonResultSchema>;
    };

const EXPECTED_PROVIDERS = {
  compare_process_captures: {
    predicates: ["rea.process-comparison"],
    ...PROCESS_PROVIDER,
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
interface FoundChangedBehavior {
  readonly result: ChangedBehaviorResult;
  /** Authenticated IDs retained from the comparisons used to compute result. */
  readonly comparisonEvidenceIds: readonly string[];
}

export const findChangedBehavior = (input: unknown): FoundChangedBehavior => {
  // The public input schema remains available to clients; this internal
  // admission only checks the list shape because parseEvidence below owns
  // validation and authentication of each retained Evidence item.
  const { comparisons } = z
    .strictObject({ comparisons: z.array(z.unknown()).min(1) })
    .parse(input);
  const evidence = comparisons.map(parseComparisonEvidence);
  assertUnique(
    evidence.map(({ evidence: { evidence_id: id } }) => id),
    "comparison Evidence",
  );
  const findings = evidence.flatMap(findingsFor).sort(compareFindings);
  const runtimeStatuses = evidence.flatMap((comparison) =>
    comparison.operation === "compare_process_captures"
      ? [comparison.result.status]
      : [],
  );
  const links = uniqueSorted(
    evidence.flatMap(({ evidence: item }) => [
      item.evidence_id,
      ...item.evidence_links,
    ]),
  );
  const result = changedBehaviorResultSchema.parse({
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
      ...evidence.flatMap(({ evidence: item }) => item.limitations),
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
  return {
    result,
    comparisonEvidenceIds: evidence.map(
      ({ evidence: { evidence_id } }) => evidence_id,
    ),
  };
};

const parseComparisonEvidence = (input: unknown): ParsedComparison => {
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
    (operation === "compare_process_captures"
      ? !isProcessEvidenceProvider(evidence.provider)
      : evidence.provider.id !== expected.id ||
        evidence.provider.name !== expected.name ||
        evidence.provider.version !== expected.version) ||
    evidence.confidence !== "derived" ||
    evidence.authority !== "analyst-inference" ||
    evidence.subject !== null
  )
    throw new TypeError(
      "Comparison Evidence operation, predicate, and provider disagree",
    );
  if (
    !comparisonSourceEvidenceIds(evidence).every((id) =>
      evidence.evidence_links.includes(id),
    )
  )
    throw new TypeError(
      "Comparison Evidence must cite both selected source observations",
    );
  return parseResult(evidence, operation);
};

const parseResult = (
  evidence: Evidence,
  operation:
    | "compare_process_captures"
    | "compare_artifacts"
    | "compare_functions",
): ParsedComparison => {
  if (operation === "compare_process_captures") {
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
    return { operation, evidence, result };
  }
  if (operation === "compare_functions") {
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    assertNestedLinks(
      evidence,
      result.dimensions.flatMap(({ evidence_links: links }) => links),
    );
    return { operation, evidence, result };
  }
  const result = artifactComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  assertNestedLinks(
    evidence,
    result.changes.flatMap(({ evidence_links: links }) => links),
  );
  return { operation, evidence, result };
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

const findingsFor = (comparison: ParsedComparison): Finding[] => {
  if (comparison.operation === "compare_process_captures")
    return processFindings(comparison);
  if (comparison.operation === "compare_functions")
    return functionFindings(comparison);
  return artifactFindings(comparison);
};

const processFindings = (
  comparison: Extract<
    ParsedComparison,
    { readonly operation: "compare_process_captures" }
  >,
): Finding[] => {
  const { evidence, result } = comparison;
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

const functionFindings = (
  comparison: Extract<
    ParsedComparison,
    { readonly operation: "compare_functions" }
  >,
): Finding[] => {
  const { evidence, result } = comparison;
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
              dimension.status === "unknown"
                ? "unresolved_branch"
                : dimension.conclusion_kind,
            limitations: dimension.limitations,
            links: dimension.evidence_links,
          }),
        ],
  );
};

const artifactFindings = (
  comparison: Extract<
    ParsedComparison,
    { readonly operation: "compare_artifacts" }
  >,
): Finding[] => {
  const { evidence, result } = comparison;
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
  compareUnicodeCodePoints(
    compositeKey([left.scope, left.dimension, left.source_comparison_id]),
    compositeKey([right.scope, right.dimension, right.source_comparison_id]),
  );

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length)
    throw new TypeError(`Changed-behavior analysis rejects duplicate ${label}`);
};
