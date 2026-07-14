import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { artifactComparisonResultSchema } from "./artifactComparison.js";
import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import { functionComparisonResultSchema } from "./functionComparison.js";
import type { JsonValue } from "./jsonValue.js";
import {
  comparisonStatusSchema,
  processCaptureComparisonSchema,
} from "./processCapture.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const functionDimensionSchema = z.enum([
  "identity",
  "pseudocode",
  "assembly",
  "comments",
  "calls",
  "references",
  "strings_names",
  "cfg",
]);
const runtimeDimensionSchema = z.enum([
  "terminal",
  "interaction",
  "exit",
  "filesystem",
  "protocol",
  "process",
  "shim",
]);
const expectedPatternSchema = z.enum([
  "cochanged",
  "static_only",
  "runtime_only",
  "both_unchanged",
]);
const observedPatternSchema = z.enum([
  ...expectedPatternSchema.options,
  "unknown",
  "truncated",
]);

const artifactSelectorSchema = z
  .object({
    kind: z.literal("artifact"),
    logical_path: z.string().min(1).max(4_096),
  })
  .strict();
const functionSelectorSchema = z
  .object({ kind: z.literal("function"), dimension: functionDimensionSchema })
  .strict();
const staticSelectorSchema = z.discriminatedUnion("kind", [
  artifactSelectorSchema,
  functionSelectorSchema,
]);

const mappingSchema = z
  .object({
    static: z
      .object({
        comparison_evidence_id: evidenceIdSchema,
        selector: staticSelectorSchema,
      })
      .strict(),
    runtime: z
      .object({
        comparison_evidence_id: evidenceIdSchema,
        dimension: runtimeDimensionSchema,
      })
      .strict(),
    side_alignment: z.enum(["left_to_left", "left_to_right"]),
    hypothesis: z
      .object({
        statement: z.string().trim().min(1).max(500),
        expected_pattern: expectedPatternSchema,
      })
      .strict(),
  })
  .strict();

/** Strict bounded input for explicit static/runtime hypothesis correlation. */
export const staticRuntimeCorrelationInputSchema = z
  .object({
    static_comparisons: z.array(evidenceSchema).min(1).max(100),
    runtime_comparisons: z.array(evidenceSchema).min(1).max(100),
    mappings: z.array(mappingSchema).min(1).max(500),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(100),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .strict();

const correlationItemSchema = z.object({
  correlation_id: z.string().regex(/^cor_[a-f0-9]{64}$/u),
  static: z.object({
    comparison_evidence_id: evidenceIdSchema,
    selector: staticSelectorSchema,
    status: comparisonStatusSchema,
    conclusion_kind: z.enum([
      "derived_relationship",
      "contradiction",
      "unresolved_branch",
    ]),
  }),
  runtime: z.object({
    comparison_evidence_id: evidenceIdSchema,
    dimension: runtimeDimensionSchema,
    status: comparisonStatusSchema,
  }),
  side_alignment: z.enum(["left_to_left", "left_to_right"]),
  hypothesis: z.object({
    statement: z.string().min(1).max(500),
    expected_pattern: expectedPatternSchema,
  }),
  observed_pattern: observedPatternSchema,
  classification: z.enum(["hypothesis", "contradiction", "unresolved_branch"]),
  evidence_links: z.array(evidenceIdSchema).min(2).max(20_100),
  limitations: z.array(z.string()),
});

/** Deterministic, paginated static/runtime correlation payload. */
export const staticRuntimeCorrelationResultSchema = z.object({
  status: z.enum(["correlated", "contradicted", "unknown", "truncated"]),
  summary: z.object({
    hypotheses: z.number().int().min(0),
    contradictions: z.number().int().min(0),
    unresolved: z.number().int().min(0),
  }),
  correlations: z.object({
    items: z.array(correlationItemSchema).max(100),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
  }),
  evidence_links: z.array(evidenceIdSchema).min(2).max(20_100),
  limitations: z.array(z.string()),
});

export type StaticRuntimeCorrelationResult = z.infer<
  typeof staticRuntimeCorrelationResultSchema
>;
type Mapping = z.infer<typeof mappingSchema>;
type CorrelationItem = z.infer<typeof correlationItemSchema>;
type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

const EXPECTED = {
  compare_artifacts: [
    "rea.artifact-comparison/v1",
    "rea-artifact-comparison",
    "REA artifact comparison",
  ],
  compare_functions: [
    "rea.function-comparison/v1",
    "rea-function-comparison",
    "REA function comparison",
  ],
  compare_process_captures: [
    "rea.process-comparison/v3",
    "rea-process",
    "REA deterministic process harness",
  ],
} as const;

/** Correlate only caller-declared static/runtime hypotheses. */
export const correlateStaticAndRuntime = (
  input: unknown,
): StaticRuntimeCorrelationResult => {
  const parsed = staticRuntimeCorrelationInputSchema.parse(input);
  const staticEvidence = parsed.static_comparisons.map(parseStatic);
  const runtimeEvidence = parsed.runtime_comparisons.map(parseRuntime);
  assertUnique(staticEvidence, "static comparison Evidence");
  assertUnique(runtimeEvidence, "runtime comparison Evidence");
  const staticById = byId(staticEvidence);
  const runtimeById = byId(runtimeEvidence);
  const correlations = parsed.mappings
    .map((mapping) => correlate(mapping, staticById, runtimeById))
    .sort((left, right) =>
      left.correlation_id.localeCompare(right.correlation_id, "en"),
    );
  if (
    new Set(correlations.map(({ correlation_id: id }) => id)).size !==
    correlations.length
  )
    throw new TypeError(
      "Static/runtime correlation rejects duplicate mappings",
    );
  const page = correlations.slice(parsed.offset, parsed.offset + parsed.limit);
  const links = uniqueSorted(
    correlations.flatMap(({ evidence_links: evidenceLinks }) => evidenceLinks),
  );
  if (links.length > 20_100)
    throw new TypeError("Static/runtime Evidence closure exceeds limit");
  const unresolved = correlations.filter(
    ({ classification }) => classification === "unresolved_branch",
  );
  const contradictions = correlations.filter(
    ({ classification }) => classification === "contradiction",
  );
  return staticRuntimeCorrelationResultSchema.parse({
    status: correlations.some(
      ({ observed_pattern: pattern }) => pattern === "truncated",
    )
      ? "truncated"
      : unresolved.length > 0
        ? "unknown"
        : contradictions.length > 0
          ? "contradicted"
          : "correlated",
    summary: {
      hypotheses:
        correlations.length - contradictions.length - unresolved.length,
      contradictions: contradictions.length,
      unresolved: unresolved.length,
    },
    correlations: {
      items: page,
      offset: parsed.offset,
      limit: parsed.limit,
      total: correlations.length,
      next_offset:
        parsed.offset + page.length < correlations.length
          ? parsed.offset + page.length
          : null,
    },
    evidence_links: links,
    limitations: [
      "Mappings are caller-declared hypotheses; consistency does not establish causality.",
      "Only explicit mappings were evaluated; similar unmapped observations were not correlated.",
    ],
  });
};

const correlate = (
  mapping: Mapping,
  staticById: ReadonlyMap<string, Evidence>,
  runtimeById: ReadonlyMap<string, Evidence>,
): CorrelationItem => {
  const staticEvidence = required(
    staticById,
    mapping.static.comparison_evidence_id,
    "static comparison",
  );
  const runtimeEvidence = required(
    runtimeById,
    mapping.runtime.comparison_evidence_id,
    "runtime comparison",
  );
  const selectedStatic = selectStatic(staticEvidence, mapping.static.selector);
  const process = processCaptureComparisonSchema.parse(
    runtimeEvidence.normalized_result,
  );
  const runtimeStatus = process[mapping.runtime.dimension];
  const pattern = observedPattern(selectedStatic.status, runtimeStatus);
  const classification =
    pattern === "unknown" || pattern === "truncated"
      ? "unresolved_branch"
      : pattern === mapping.hypothesis.expected_pattern
        ? "hypothesis"
        : "contradiction";
  const projection = {
    static: mapping.static,
    runtime: mapping.runtime,
    side_alignment: mapping.side_alignment,
    hypothesis: mapping.hypothesis,
  } satisfies JsonValue;
  return correlationItemSchema.parse({
    correlation_id: `cor_${sha256(canonicalJson(projection))}`,
    static: { ...mapping.static, ...selectedStatic },
    runtime: { ...mapping.runtime, status: runtimeStatus },
    side_alignment: mapping.side_alignment,
    hypothesis: mapping.hypothesis,
    observed_pattern: pattern,
    classification,
    evidence_links: uniqueSorted([
      staticEvidence.evidence_id,
      ...staticEvidence.evidence_links,
      runtimeEvidence.evidence_id,
      ...runtimeEvidence.evidence_links,
    ]),
    limitations: uniqueSorted([
      ...staticEvidence.limitations,
      ...runtimeEvidence.limitations,
      ...process.limitations,
      "This correlation tests an explicit hypothesis and does not establish causality.",
      "Side alignment is caller-declared and was not independently validated against source subjects or environments.",
    ]),
  });
};

const selectStatic = (
  evidence: Evidence,
  selector: z.infer<typeof staticSelectorSchema>,
): Pick<CorrelationItem["static"], "status" | "conclusion_kind"> => {
  if (selector.kind === "function") {
    if (evidence.operation !== "compare_functions")
      throw new TypeError(
        "Function selector requires function comparison Evidence",
      );
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    const matches = result.dimensions.filter(
      ({ dimension }) => dimension === selector.dimension,
    );
    if (matches.length !== 1)
      throw new TypeError("Function selector must resolve exactly once");
    return {
      status: matches[0]!.status,
      conclusion_kind: matches[0]!.conclusion_kind,
    };
  }
  if (evidence.operation !== "compare_artifacts")
    throw new TypeError(
      "Artifact selector requires artifact comparison Evidence",
    );
  const result = artifactComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  if (
    result.changes.offset !== 0 ||
    result.changes.next_offset !== null ||
    result.changes.items.length !== result.changes.total
  )
    throw new TypeError(
      "Static/runtime correlation requires complete artifact comparison pagination",
    );
  const matches = result.changes.items.filter(
    ({ logical_path: path }) => path === selector.logical_path,
  );
  if (matches.length !== 1)
    throw new TypeError(
      "Artifact selector must resolve exactly one reported delta",
    );
  const status = matches[0]!.classification;
  return {
    status,
    conclusion_kind:
      status === "contradiction"
        ? "contradiction"
        : status === "unknown"
          ? "unresolved_branch"
          : "derived_relationship",
  };
};

const parseStatic = (input: unknown): Evidence => {
  const evidence = parseEvidence(input);
  if (
    evidence.operation !== "compare_artifacts" &&
    evidence.operation !== "compare_functions"
  )
    throw new TypeError(
      "Static/runtime correlation requires artifact or function comparison Evidence",
    );
  assertComparisonIdentity(evidence);
  if (evidence.operation === "compare_artifacts") {
    const result = artifactComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    assertCompleteArtifactResult(result);
    assertNestedLinks(
      evidence,
      result.changes.items.flatMap(({ evidence_links: links }) => links),
    );
  } else {
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    assertNestedLinks(
      evidence,
      result.dimensions.flatMap(({ evidence_links: links }) => links),
    );
  }
  return evidence;
};

const assertNestedLinks = (
  evidence: Evidence,
  nestedLinks: readonly string[],
): void => {
  const closure = new Set(evidence.evidence_links);
  if (nestedLinks.some((evidenceId) => !closure.has(evidenceId)))
    throw new TypeError(
      "Comparison finding cites Evidence outside its top-level closure",
    );
};

const parseRuntime = (input: unknown): Evidence => {
  const evidence = parseEvidence(input);
  if (evidence.operation !== "compare_process_captures")
    throw new TypeError(
      "Static/runtime correlation requires process comparison Evidence",
    );
  assertComparisonIdentity(evidence);
  processCaptureComparisonSchema.parse(evidence.normalized_result);
  return evidence;
};

const assertComparisonIdentity = (evidence: Evidence): void => {
  const expected = EXPECTED[evidence.operation as keyof typeof EXPECTED];
  if (
    expected === undefined ||
    evidence.predicate_type !== expected[0] ||
    evidence.provider.id !== expected[1] ||
    evidence.provider.name !== expected[2] ||
    evidence.provider.version !==
      (evidence.operation === "compare_process_captures" ? "3" : "1") ||
    evidence.confidence !== "derived" ||
    evidence.authority !== "analyst-inference" ||
    evidence.subject !== null ||
    evidence.evidence_links.length < 2 ||
    new Set(evidence.evidence_links).size !== evidence.evidence_links.length
  )
    throw new TypeError(
      "Comparison Evidence operation, predicate, provider, or citations disagree",
    );
  const parameterLinks = comparisonParameterLinks(evidence);
  if (!sameSet(parameterLinks, evidence.evidence_links))
    throw new TypeError(
      "Comparison Evidence closure disagrees with its source parameters",
    );
};

const comparisonParameterLinks = (evidence: Evidence): string[] => {
  if (evidence.operation === "compare_process_captures") {
    const parameters = z
      .object({
        left_evidence_id: evidenceIdSchema,
        right_evidence_id: evidenceIdSchema,
      })
      .passthrough()
      .parse(evidence.parameters);
    return [parameters.left_evidence_id, parameters.right_evidence_id];
  }
  const parameters = z
    .object({
      left_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
      right_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
    })
    .passthrough()
    .parse(evidence.parameters);
  return [...parameters.left_evidence_ids, ...parameters.right_evidence_ids];
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((item) => right.includes(item));

const assertCompleteArtifactResult = (
  result: z.infer<typeof artifactComparisonResultSchema>,
): void => {
  if (
    result.changes.offset !== 0 ||
    result.changes.next_offset !== null ||
    result.changes.items.length !== result.changes.total
  )
    throw new TypeError(
      "Static/runtime correlation requires complete artifact comparison pagination",
    );
};

const observedPattern = (
  staticStatus: ComparisonStatus,
  runtimeStatus: ComparisonStatus,
): z.infer<typeof observedPatternSchema> => {
  if (staticStatus === "truncated" || runtimeStatus === "truncated")
    return "truncated";
  if (staticStatus === "unknown" || runtimeStatus === "unknown")
    return "unknown";
  const staticChanged = staticStatus !== "unchanged";
  const runtimeChanged = runtimeStatus !== "unchanged";
  if (staticChanged && runtimeChanged) return "cochanged";
  if (staticChanged) return "static_only";
  if (runtimeChanged) return "runtime_only";
  return "both_unchanged";
};

const required = (
  values: ReadonlyMap<string, Evidence>,
  id: string,
  label: string,
): Evidence => {
  const value = values.get(id);
  if (value === undefined)
    throw new TypeError(`Mapping references absent ${label} Evidence`);
  return value;
};

const byId = (evidence: readonly Evidence[]): Map<string, Evidence> =>
  new Map(evidence.map((item) => [item.evidence_id, item]));

const assertUnique = (evidence: readonly Evidence[], label: string): void => {
  if (
    new Set(evidence.map(({ evidence_id: id }) => id)).size !== evidence.length
  )
    throw new TypeError(
      `Static/runtime correlation rejects duplicate ${label}`,
    );
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError(
      "RFC 8785 canonicalization rejected correlation mapping",
    );
  return serialized;
};
