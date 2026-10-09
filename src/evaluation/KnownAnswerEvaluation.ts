import { visit } from "jsonc-parser";
import { z } from "zod";

import { parseEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

/** One closed fixture assertion and the producer facts that must support it. */
export interface FixtureClaimExpectation {
  readonly id: string;
  readonly expectedValue: JsonValue;
  readonly source: {
    readonly operation: string;
    readonly authority: Evidence["authority"];
    readonly confidence: Evidence["confidence"];
    readonly subject?: { readonly path: string; readonly sha256?: string };
    readonly parameters?: Readonly<Record<string, JsonValue>>;
    readonly linkedSubjects?: readonly {
      readonly operation: string;
      readonly path: string;
      readonly sha256?: string;
    }[];
    readonly select: (normalizedResult: JsonValue) => JsonValue | undefined;
  };
}

/** Failed fixture constraints, distinct from unrestricted natural-language correctness. */
export type FixtureClaimFailure =
  | "claim_missing"
  | "value_mismatch"
  | "claim_confidence_mismatch"
  | "claim_authority_mismatch"
  | "unknown_evidence"
  | "conflicting_evidence"
  | "source_operation_mismatch"
  | "source_confidence_mismatch"
  | "source_authority_mismatch"
  | "source_subject_mismatch"
  | "source_parameters_mismatch"
  | "source_links_mismatch"
  | "source_assertion_mismatch"
  | "selector_failed";

/** Diagnostics for a single configured fixture assertion. */
export interface FixtureClaimAssessment {
  readonly id: string;
  readonly status: "passed" | "failed";
  readonly failures: readonly FixtureClaimFailure[];
}

/** Only the configured closed fixture claims are assessed. */
export interface KnownAnswerAssessment {
  readonly scope: "configured_fixture_claims";
  readonly status: "passed" | "failed" | "not_assessed";
  readonly manifestFailures: readonly string[];
  readonly claims: readonly FixtureClaimAssessment[];
}

const authoritySchema = z.enum([
  "shipped-artifact",
  "controlled-replay",
  "historical-reference",
  "external-service",
  "analyst-inference",
]);
const confidenceSchema = z.enum(["observed", "derived", "inferred"]);
const subjectSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
const expectationSchema = z.strictObject({
  id: z.string().min(1),
  expectedValue: jsonValueSchema,
  source: z.strictObject({
    operation: z.string().min(1),
    authority: authoritySchema,
    confidence: confidenceSchema,
    subject: subjectSchema.optional(),
    parameters: z.record(z.string(), jsonValueSchema).optional(),
    linkedSubjects: z
      .array(subjectSchema.extend({ operation: z.string().min(1) }))
      .optional(),
    select: z.custom<FixtureClaimExpectation["source"]["select"]>(
      (value) => typeof value === "function",
    ),
  }),
});
const finalAnswerSchema = z.strictObject({
  claims: z.array(
    z.strictObject({
      id: z.string().min(1),
      value: jsonValueSchema,
      evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
      confidence: confidenceSchema,
      authority: authoritySchema,
    }),
  ),
});
type FinalClaim = z.infer<typeof finalAnswerSchema>["claims"][number];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;
const canonicalValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
};
const sameJson = (left: unknown, right: unknown): boolean => {
  const parsedLeft = jsonValueSchema.safeParse(left);
  const parsedRight = jsonValueSchema.safeParse(right);
  return (
    parsedLeft.success &&
    parsedRight.success &&
    JSON.stringify(canonicalValue(parsedLeft.data)) ===
      JSON.stringify(canonicalValue(parsedRight.data))
  );
};

const parseClosedAnswer = (text: string): unknown => {
  const objects: Set<string>[] = [];
  let invalid = false;
  try {
    visit(
      text,
      {
        onObjectBegin: () => {
          objects.push(new Set());
        },
        onObjectProperty: (key) => {
          const keys = objects.at(-1);
          if (keys === undefined || keys.has(key)) invalid = true;
          keys?.add(key);
        },
        onObjectEnd: () => {
          objects.pop();
        },
        onError: () => {
          invalid = true;
        },
      },
      {
        disallowComments: true,
        allowTrailingComma: false,
        allowEmptyContent: false,
      },
    );
    if (invalid) return undefined;
    // The JSON visitor checked syntax and duplicate members before JSON.parse can fold them.
    return JSON.parse(text);
  } catch (error) {
    // Syntax and nesting failures are malformed final-answer input, not an evaluation crash.
    if (error instanceof SyntaxError || error instanceof RangeError)
      return undefined;
    throw error;
  }
};

interface DeliveredEvidence {
  readonly records: Map<string, Evidence>;
  readonly conflicts: Set<string>;
}

const consistentAliases = (
  value: Record<string, unknown>,
  left: string,
  right: string,
): boolean =>
  value[left] === undefined ||
  value[right] === undefined ||
  value[left] === value[right];

const completedCall = (event: unknown): Record<string, unknown> | undefined => {
  const value = record(event);
  const item =
    value?.type === "item.completed"
      ? record(value.item)
      : value?.type === "mcp_tool_call" && value.status === "completed"
        ? value
        : undefined;
  if (item?.type !== "mcp_tool_call") return undefined;
  const server = item.server ?? item.server_name;
  if (
    typeof server !== "string" ||
    server.toLowerCase() !== "rea" ||
    (item.status !== undefined && item.status !== "completed") ||
    (item.error !== undefined && item.error !== null)
  )
    return undefined;
  if (
    !consistentAliases(item, "server", "server_name") ||
    !consistentAliases(item, "tool", "name")
  )
    return undefined;
  return item;
};

const consistentJsonAliases = (
  value: Record<string, unknown>,
  left: string,
  right: string,
): boolean =>
  value[left] === undefined ||
  value[left] === null ||
  value[right] === undefined ||
  value[right] === null ||
  sameJson(value[left], value[right]);

const evidenceFromCall = (
  item: Record<string, unknown>,
): Evidence | undefined => {
  if (!consistentJsonAliases(item, "result", "output")) return undefined;
  const result = record(item.result ?? item.output);
  if (
    result === undefined ||
    result.isError === true ||
    (result.error !== undefined && result.error !== null)
  )
    return undefined;
  const structured = record(
    result.structuredContent ?? result.structured_content,
  );
  if (
    structured === undefined ||
    (structured.error !== undefined && structured.error !== null)
  )
    return undefined;
  if (
    result.structuredContent !== undefined &&
    result.structured_content !== undefined &&
    !sameJson(result.structuredContent, result.structured_content)
  )
    return undefined;
  let evidence: Evidence;
  try {
    evidence = parseEvidence(structured);
  } catch {
    // Transcript output is untrusted; invalid Evidence cannot support a claim.
    return undefined;
  }
  if ((item.tool ?? item.name) !== evidence.operation) return undefined;
  return evidence;
};

const collectDeliveredEvidence = (
  events: readonly unknown[],
): DeliveredEvidence => {
  const records = new Map<string, Evidence>();
  const conflicts = new Set<string>();
  for (const event of events) {
    const item = completedCall(event);
    if (item === undefined) continue;
    const evidence = evidenceFromCall(item);
    if (evidence === undefined) continue;
    const previous = records.get(evidence.evidence_id);
    if (previous !== undefined && !sameJson(previous, evidence))
      conflicts.add(evidence.evidence_id);
    else records.set(evidence.evidence_id, evidence);
  }
  return { records, conflicts };
};

const matchesSubject = (
  evidence: Evidence,
  expected: { readonly path: string; readonly sha256?: string },
): boolean =>
  evidence.subject?.local_path === expected.path &&
  (expected.sha256 === undefined ||
    evidence.subject.digest.sha256 === expected.sha256);

const matchesParameters = (
  evidence: Evidence,
  expected: Readonly<Record<string, JsonValue>> | undefined,
): boolean =>
  expected === undefined ||
  Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(evidence.parameters, key) &&
      sameJson(evidence.parameters[key], value),
  );

const matchesLinks = (
  evidence: Evidence,
  source: FixtureClaimExpectation["source"],
  delivered: DeliveredEvidence,
): boolean =>
  (source.linkedSubjects ?? []).every((expected) =>
    evidence.evidence_links.some((id) => {
      const linked = delivered.records.get(id);
      return (
        linked !== undefined &&
        !delivered.conflicts.has(id) &&
        linked.operation === expected.operation &&
        matchesSubject(linked, expected)
      );
    }),
  );

const assessClaim = (
  expected: FixtureClaimExpectation,
  claim: FinalClaim | undefined,
  delivered: DeliveredEvidence,
): FixtureClaimAssessment => {
  const failures: FixtureClaimFailure[] = [];
  if (claim === undefined)
    return { id: expected.id, status: "failed", failures: ["claim_missing"] };
  if (!sameJson(claim.value, expected.expectedValue))
    failures.push("value_mismatch");
  if (claim.confidence !== expected.source.confidence)
    failures.push("claim_confidence_mismatch");
  if (claim.authority !== expected.source.authority)
    failures.push("claim_authority_mismatch");
  const evidence = delivered.records.get(claim.evidence_id);
  if (evidence === undefined) failures.push("unknown_evidence");
  else if (delivered.conflicts.has(claim.evidence_id))
    failures.push("conflicting_evidence");
  else {
    if (evidence.operation !== expected.source.operation)
      failures.push("source_operation_mismatch");
    if (evidence.confidence !== expected.source.confidence)
      failures.push("source_confidence_mismatch");
    if (evidence.authority !== expected.source.authority)
      failures.push("source_authority_mismatch");
    if (
      expected.source.subject !== undefined &&
      !matchesSubject(evidence, expected.source.subject)
    )
      failures.push("source_subject_mismatch");
    if (!matchesParameters(evidence, expected.source.parameters))
      failures.push("source_parameters_mismatch");
    if (!matchesLinks(evidence, expected.source, delivered))
      failures.push("source_links_mismatch");
    try {
      if (
        !sameJson(
          expected.source.select(evidence.normalized_result),
          expected.expectedValue,
        )
      )
        failures.push("source_assertion_mismatch");
    } catch {
      // Producer-specific selectors may reject malformed representations; preserve a failed assessment.
      failures.push("selector_failed");
    }
  }
  return {
    id: expected.id,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };
};

/** Grade closed answers only against configured fixture truth and delivered authenticated Evidence. */
export const evaluateKnownAnswers = (
  events: readonly unknown[],
  finalMessage: string,
  expectations: readonly FixtureClaimExpectation[] | undefined,
): KnownAnswerAssessment => {
  const scope = "configured_fixture_claims";
  if (expectations === undefined)
    return { scope, status: "not_assessed", manifestFailures: [], claims: [] };
  const rubric = z.array(expectationSchema).min(1).safeParse(expectations);
  if (!rubric.success)
    return {
      scope,
      status: "failed",
      manifestFailures: ["invalid_fixture_rubric"],
      claims: [],
    };
  const expectedIds = new Set(expectations.map(({ id }) => id));
  if (expectedIds.size !== expectations.length)
    return {
      scope,
      status: "failed",
      manifestFailures: ["duplicate_fixture_claim_ids"],
      claims: [],
    };
  const manifest = finalAnswerSchema.safeParse(parseClosedAnswer(finalMessage));
  if (!manifest.success)
    return {
      scope,
      status: "failed",
      manifestFailures: ["invalid_final_claim_manifest"],
      claims: [],
    };
  const manifestFailures: string[] = [];
  const submitted = new Map<string, FinalClaim>();
  for (const claim of manifest.data.claims) {
    if (submitted.has(claim.id))
      manifestFailures.push(`duplicate_claim:${claim.id}`);
    if (!expectedIds.has(claim.id))
      manifestFailures.push(`unknown_claim:${claim.id}`);
    submitted.set(claim.id, claim);
  }
  const delivered = collectDeliveredEvidence(events);
  const claims = expectations.map((expected) =>
    assessClaim(expected, submitted.get(expected.id), delivered),
  );
  return {
    scope,
    status:
      manifestFailures.length === 0 &&
      claims.every(({ status }) => status === "passed")
        ? "passed"
        : "failed",
    manifestFailures,
    claims,
  };
};
