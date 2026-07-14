import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { artifactComparisonResultSchema } from "./artifactComparison.js";
import { artifactInventoryResultSchema } from "./artifactGraph.js";
import { parseEvidence, type Evidence } from "./evidence.js";
import { parseEvidenceBundle } from "./evidenceBundle.js";
import { functionComparisonResultSchema } from "./functionComparison.js";
import { functionDossierSchema } from "./hopperValues.js";
import {
  deriveProcessComparisonStatus,
  PROCESS_COMPARISON_DIMENSIONS,
  processCaptureComparisonSchema,
  processCaptureSchema,
} from "./processCapture.js";
import {
  reconstructionClaimResultSchema,
  reconstructionSpecificationSchema,
  reconstructionVerificationResultSchema,
  type ReconstructionClaim as Claim,
  type ReconstructionClaimResult as ClaimResult,
  type ReconstructionObservedStatus as ObservedStatus,
  type ReconstructionVerificationResult,
} from "./reconstructionVerificationSchemas.js";
import {
  reconstructionClaimUnknowns,
  reconstructionProbes,
  reconstructionUnknownHeads,
} from "./reconstructionUnknowns.js";
import type { ResidualUnknown } from "./residualUnknown.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);

export {
  reconstructionVerificationInputSchema,
  reconstructionVerificationResultSchema,
} from "./reconstructionVerificationSchemas.js";
export type { ReconstructionVerificationResult } from "./reconstructionVerificationSchemas.js";

const MAX_BUNDLE_RECORDS = 20_100;
const MAX_UNKNOWN_REVISIONS = 10_000;
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;

const providers = {
  behavioral: {
    operation: "compare_process_captures",
    predicate: "rea.process-comparison/v3",
    id: "rea-process",
    name: "REA deterministic process harness",
  },
  "structural-function": {
    operation: "compare_functions",
    predicate: "rea.function-comparison/v1",
    id: "rea-function-comparison",
    name: "REA function comparison",
  },
  "structural-artifact": {
    operation: "compare_artifacts",
    predicate: "rea.artifact-comparison/v1",
    id: "rea-artifact-comparison",
    name: "REA artifact comparison",
  },
} as const;

/** Verify only explicitly declared claims; no global equivalence is inferred. */
export const verifyReconstruction = (
  specificationInput: unknown,
  bundleInput: unknown,
  offset: number,
  limit: number,
): ReconstructionVerificationResult => {
  const specification =
    reconstructionSpecificationSchema.parse(specificationInput);
  enforceInputSize(bundleInput);
  const bundle = parseEvidenceBundle(bundleInput);
  if (bundle.records.length > MAX_BUNDLE_RECORDS)
    throw new TypeError("Reconstruction Evidence record limit exceeded");
  if (bundle.unknowns.length > MAX_UNKNOWN_REVISIONS)
    throw new TypeError("Reconstruction unknown revision limit exceeded");
  const records = new Map(
    bundle.records.map((item) => [item.evidence_id, item]),
  );
  const heads = reconstructionUnknownHeads(bundle.unknowns);
  const results = specification.claims
    .map((claim) => evaluateClaim(claim, records, heads))
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id, "en"));
  const page = results.slice(offset, offset + limit);
  const failed = count(results, "fail");
  const unresolved = count(results, "unknown");
  const probes = reconstructionProbes(results, heads);
  const evidenceLinks = uniqueSorted(
    results.flatMap(({ evidence_links: links }) => links),
  );
  if (evidenceLinks.length > 20_100)
    throw new TypeError("Reconstruction Evidence closure exceeds limit");
  const output = {
    status: failed > 0 ? "fail" : unresolved > 0 ? "unknown" : "pass",
    specification_sha256: digest({
      ...specification,
      claims: [...specification.claims].sort((left, right) =>
        left.claim_id.localeCompare(right.claim_id, "en"),
      ),
    }),
    summary: {
      total: results.length,
      passed: count(results, "pass"),
      failed,
      unknown: unresolved,
      behavioral: results.filter(({ kind }) => kind === "behavioral").length,
      structural: results.filter(({ kind }) => kind !== "behavioral").length,
    },
    claims: {
      items: page,
      offset,
      limit,
      total: results.length,
      next_offset:
        offset + page.length < results.length ? offset + page.length : null,
    },
    recommended_probes: probes.items,
    evidence_links: evidenceLinks,
    limitations: [
      "Pass means every declared claim passed; it does not establish global implementation equivalence.",
      ...(probes.truncated
        ? ["Recommended probes were truncated at the 2,000-item limit."]
        : []),
    ],
  };
  return reconstructionVerificationResultSchema.parse(output);
};

const evaluateClaim = (
  claim: Claim,
  records: ReadonlyMap<string, Evidence>,
  heads: ReadonlyMap<string, ResidualUnknown>,
): ClaimResult => {
  const comparison = records.get(claim.comparison_evidence_id);
  if (comparison === undefined)
    throw new TypeError(
      `Missing comparison Evidence ${claim.comparison_evidence_id}`,
    );
  validateComparisonIdentity(claim, comparison);
  const sides = sourceSides(claim, comparison);
  const allSourceIds = [...sides.left, ...sides.right];
  if (new Set(allSourceIds).size !== allSourceIds.length)
    throw new TypeError(
      "Comparison source Evidence must be unique and two-sided",
    );
  if (!sameSet(comparison.evidence_links, allSourceIds))
    throw new TypeError(
      "Comparison Evidence closure disagrees with its parameters",
    );
  const sources = allSourceIds.map((id) => {
    const source = records.get(id);
    if (source === undefined)
      throw new TypeError(`Missing source Evidence ${id}`);
    return source;
  });
  validateSourceKinds(claim, sources);
  const observed = observedStatus(claim, comparison);
  const limitations = authorityLimitations(claim, sources, sides);
  const relevantUnknowns = reconstructionClaimUnknowns(
    heads,
    comparison.evidence_id,
    allSourceIds,
  );
  const status = classify(observed, limitations, relevantUnknowns);
  const displayedUnknowns = relevantUnknowns.slice(0, 100);
  const hiddenUnknownCount = relevantUnknowns.length - displayedUnknowns.length;
  return reconstructionClaimResultSchema.parse({
    claim_id: claim.claim_id,
    kind: claim.kind,
    dimension: claim.dimension,
    status,
    observed_status: observed,
    comparison_evidence_id: comparison.evidence_id,
    left_evidence_ids: sides.left,
    right_evidence_ids: sides.right,
    evidence_links: uniqueSorted([comparison.evidence_id, ...allSourceIds]),
    unknown_ids: displayedUnknowns.map(({ unknown_id: id }) => id),
    limitations: uniqueSorted([
      ...comparison.limitations,
      ...limitations,
      ...displayedUnknowns.map(
        ({ question }) => `Residual unknown: ${question}`,
      ),
      ...(hiddenUnknownCount > 0
        ? [
            `${hiddenUnknownCount} additional active residual unknowns affect this claim but are omitted by the 100-item display limit.`,
          ]
        : []),
    ]),
  });
};

const validateSourceKinds = (
  claim: Claim,
  sources: readonly Evidence[],
): void => {
  const expected =
    claim.kind === "behavioral"
      ? ["capture_process_scenario", "rea.process-capture/v4"]
      : claim.kind === "structural-function"
        ? ["analyze_function", "rea.analysis/v2"]
        : ["inventory_artifact", "rea.analysis/v2"];
  if (
    sources.some(
      (source) =>
        source.operation !== expected[0] ||
        source.predicate_type !== expected[1],
    )
  )
    throw new TypeError(
      "Comparison source Evidence has an unexpected observation type",
    );
  for (const source of sources) {
    if (claim.kind === "behavioral")
      processCaptureSchema.parse(source.normalized_result);
    else if (claim.kind === "structural-function")
      functionDossierSchema.parse(source.normalized_result);
    else artifactInventoryResultSchema.parse(source.normalized_result);
  }
};

const validateComparisonIdentity = (claim: Claim, evidence: Evidence): void => {
  parseEvidence(evidence);
  const expected = providers[claim.kind];
  if (
    evidence.operation !== expected.operation ||
    evidence.predicate_type !== expected.predicate ||
    evidence.provider.id !== expected.id ||
    evidence.provider.name !== expected.name ||
    evidence.provider.version !== (claim.kind === "behavioral" ? "3" : "1") ||
    evidence.confidence !== "derived" ||
    evidence.authority !== "analyst-inference" ||
    evidence.subject !== null
  )
    throw new TypeError("Comparison Evidence identity or authority disagrees");
};

const sourceSides = (
  claim: Claim,
  evidence: Evidence,
): { left: string[]; right: string[] } => {
  const parameters = evidence.parameters;
  if (claim.kind === "behavioral") {
    const parsed = z
      .object({
        left_evidence_id: evidenceIdSchema,
        right_evidence_id: evidenceIdSchema,
      })
      .passthrough()
      .parse(parameters);
    return {
      left: [parsed.left_evidence_id],
      right: [parsed.right_evidence_id],
    };
  }
  const parsed = z
    .object({
      left_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
      right_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
    })
    .passthrough()
    .parse(parameters);
  return { left: parsed.left_evidence_ids, right: parsed.right_evidence_ids };
};

const observedStatus = (claim: Claim, evidence: Evidence): ObservedStatus => {
  if (claim.kind === "behavioral") {
    const result = processCaptureComparisonSchema.parse(
      evidence.normalized_result,
    );
    validateProcessStatus(result);
    return claim.dimension === "overall"
      ? result.status
      : result[claim.dimension];
  }
  if (claim.kind === "structural-function") {
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    if (claim.dimension === "overall") return result.status;
    const dimension = result.dimensions.find(
      (item) => item.dimension === claim.dimension,
    );
    if (dimension === undefined)
      throw new TypeError("Function comparison dimension missing");
    if (
      dimension.evidence_links.some(
        (id) => !evidence.evidence_links.includes(id),
      )
    )
      throw new TypeError(
        "Function dimension cites Evidence outside comparison closure",
      );
    return dimension.status;
  }
  const result = artifactComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  if (
    result.changes.offset !== 0 ||
    result.changes.next_offset !== null ||
    result.changes.items.length !== result.changes.total
  )
    return "unknown";
  if (
    result.changes.items.some((item) =>
      item.evidence_links.some((id) => !evidence.evidence_links.includes(id)),
    )
  )
    throw new TypeError(
      "Artifact change cites Evidence outside comparison closure",
    );
  return result.status;
};

const validateProcessStatus = (
  result: z.infer<typeof processCaptureComparisonSchema>,
): void => {
  const expected = deriveProcessComparisonStatus(
    PROCESS_COMPARISON_DIMENSIONS.map((dimension) => result[dimension]),
  );
  if (result.status !== expected)
    throw new TypeError("Process comparison status contradicts its dimensions");
};

const authorityLimitations = (
  claim: Claim,
  sources: readonly Evidence[],
  sides: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  },
): string[] => {
  const requiredAuthority =
    claim.kind === "behavioral" ? "controlled-replay" : "shipped-artifact";
  const limitations: string[] = [];
  if (
    sources.some(
      (source) =>
        source.authority !== requiredAuthority ||
        (claim.kind === "structural-function"
          ? source.confidence === "inferred"
          : source.confidence !== "observed"),
    )
  )
    limitations.push(
      `Source Evidence lacks qualifying ${requiredAuthority} authority.`,
    );
  if (
    claim.kind !== "behavioral" &&
    sources.some(({ subject }) => subject === null)
  )
    limitations.push("Structural source artifact identity is unavailable.");
  if (claim.kind === "behavioral") {
    const byId = new Map(sources.map((source) => [source.evidence_id, source]));
    const left = byId.get(sides.left[0] ?? "");
    const right = byId.get(sides.right[0] ?? "");
    if (
      left?.environment === null ||
      right?.environment === null ||
      JSON.stringify(left?.environment) !== JSON.stringify(right?.environment)
    )
      limitations.push(
        "Controlled replay environments are unavailable or incompatible.",
      );
  }
  return limitations;
};

const classify = (
  observed: ObservedStatus,
  limitations: readonly string[],
  unknowns: readonly ResidualUnknown[],
): ClaimResult["status"] => {
  if (limitations.length > 0) return "unknown";
  if (["changed", "added", "removed", "contradiction"].includes(observed))
    return "fail";
  if (observed === "unknown" || observed === "truncated" || unknowns.length > 0)
    return "unknown";
  return "pass";
};

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Specification canonicalization failed");
  return createHash("sha256").update(encoded).digest("hex");
};

const enforceInputSize = (value: unknown): void => {
  const encoded = canonicalize(value);
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES
  )
    throw new TypeError("Reconstruction Evidence bundle exceeds byte limit");
};

const count = (
  items: readonly ClaimResult[],
  status: ClaimResult["status"],
): number => items.filter((item) => item.status === status).length;
const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  uniqueSorted(left).every((id, index) => id === uniqueSorted(right)[index]);
const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
