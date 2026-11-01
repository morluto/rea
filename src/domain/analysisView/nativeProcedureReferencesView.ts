import { z } from "zod";
import { canonicalJson } from "../comparisonSemantics.js";
import { jsonValueSchema } from "../jsonValue.js";
import { procedureIdentitySchema } from "../native/procedureInfo.js";
import {
  referenceEdgeSchema,
  unresolvedCallSchema,
} from "../native/nativeReference.js";
import { procedureReferencesSchema } from "../native/procedureReferences.js";
import { err, ok } from "../result.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const page = {
  kind: z.literal("native-procedure-references"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};
export const procedureReferenceViewRequests = {
  references: z.strictObject({
    ...page,
    collection: z.literal("references"),
    source_address: z
      .string()
      .min(1)
      .optional()
      .describe("Match an exact retained source address."),
    target_address: z
      .string()
      .min(1)
      .optional()
      .describe("Match an exact retained target address."),
  }),
  unresolved_calls: z.strictObject({
    ...page,
    collection: z.literal("unresolved_calls"),
  }),
} as const;
export const nativeProcedureReferencesViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    procedureReferenceViewRequests.references,
    procedureReferenceViewRequests.unresolved_calls,
  ],
);
const endpointSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("null") }),
  z.strictObject({ kind: z.literal("selected-procedure") }),
  z.strictObject({ kind: z.literal("inline"), value: procedureIdentitySchema }),
]);
const rowSchema = referenceEdgeSchema.extend({
  source_procedure: endpointSchema,
  target_procedure: endpointSchema,
  source_index: z.int().nonnegative(),
});
export const procedureReferenceViewItems = {
  references: z.strictObject({
    collection: z.literal("references"),
    rows: z.array(rowSchema),
  }),
  unresolved_calls: z.strictObject({
    collection: z.literal("unresolved_calls"),
    rows: z.array(
      z.strictObject({
        source_index: z.int().nonnegative(),
        value: unresolvedCallSchema,
      }),
    ),
  }),
} as const;
export const procedureReferenceSummarySchema = z.strictObject({
  procedure: procedureIdentitySchema,
  direction: z.enum(["incoming", "outgoing"]),
  reference_kinds_available: z.boolean(),
  reference_count: z.int().nonnegative(),
  unresolved_call_count: z.int().nonnegative(),
});
const readSource = createAnalysisViewResultReader(procedureReferencesSchema);
// The analysis-view projection allowance leaves room for Evidence and MCP
// encoding expansion. Count JSON without serializing the full page.
const PAGE_BYTES = 1024 * 1024;
const DIGEST_BYTES = jsonValueByteLength({ view_digest: "0".repeat(64) }) - 1;

/** Page the retained result without re-querying the provider or changing source coverage. */
export const projectNativeProcedureReferencesView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "native-procedure-references")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Procedure-reference Evidence supports summary and native-procedure-references views.",
        },
      ]),
    );
  assertOwnedView<
    | SummaryAnalysisView
    | z.output<typeof nativeProcedureReferencesViewRequestSchema>
  >(view, "summary", "native-procedure-references");
  const parsed = readSource(parent);
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  const summary = {
    procedure: source.procedure,
    direction: source.direction,
    reference_kinds_available: source.reference_kinds_available,
    reference_count: source.references.length,
    unresolved_call_count: source.unresolved_calls.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "procedure_references" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    source_provider: parent.provider ?? null,
    source_analysis_profile_digest: parent.analysisProfile?.digest ?? null,
    source_parameters: jsonValueSchema.parse(parent.parameters ?? null),
    limitations: boundedViewMessages(
      parent.limitations,
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Page coverage describes retained references, not provider discovery completeness or runtime execution.",
    ],
  };
  const tooLarge = () =>
    err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "transport",
        "The selected procedure-reference view cannot fit the analysis-view byte budget.",
        { parent_evidence_id: parent.evidenceId, limit_bytes: PAGE_BYTES },
        {
          retryable: false,
          remediationAction:
            "An individual row or the page context exceeds the fixed 1,048,576-byte projection allowance. Use the complete input Evidence or its local bundle, or retrieve or export the retained parent by the reported ID. If a CLI failure includes a partial observation, that observation is the completed parent.",
        },
      ),
    );
  if (view.kind === "summary") {
    const result = {
      ...shared,
      kind: "summary" as const,
      view,
      summary,
      coverage: completeWithinViewCoverage(1, 1),
    };
    return jsonValueByteLength(result as JsonValue, PAGE_BYTES - DIGEST_BYTES) >
      PAGE_BYTES - DIGEST_BYTES
      ? tooLarge()
      : ok(result);
  }
  const common = {
    ...shared,
    kind: "native-procedure-references" as const,
    view,
    summary,
  };
  const header = {
    ...common,
    items: { collection: view.collection, rows: [] },
    byte_limited: false,
    coverage: {
      status: "complete-within-view",
      examined: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
      next_offset: Number.MAX_SAFE_INTEGER,
      exhausted: false,
    },
  };
  let bytes =
    DIGEST_BYTES +
    jsonValueByteLength(header as JsonValue, PAGE_BYTES - DIGEST_BYTES);
  if (bytes > PAGE_BYTES) return tooLarge();
  const referenceRows: z.infer<typeof rowSchema>[] = [];
  const unresolvedRows: {
    source_index: number;
    value: z.infer<typeof unresolvedCallSchema>;
  }[] = [];
  let total = 0;
  let byteLimited = false;
  const offer = (row: JsonValue) => {
    const size =
      jsonValueByteLength(row, PAGE_BYTES - bytes) +
      (total > view.offset ? 1 : 0);
    if (bytes + size > PAGE_BYTES) {
      byteLimited = true;
      return false;
    }
    bytes += size;
    return true;
  };
  if (view.collection === "unresolved_calls") {
    for (const [index, value] of source.unresolved_calls.entries()) {
      if (
        total >= view.offset &&
        unresolvedRows.length < view.limit &&
        !byteLimited
      ) {
        const row = { source_index: index, value };
        if (offer(row)) unresolvedRows.push(row);
      }
      total++;
    }
    if (byteLimited && unresolvedRows.length === 0) return tooLarge();
    return ok({
      ...common,
      view,
      items: { collection: "unresolved_calls" as const, rows: unresolvedRows },
      byte_limited: byteLimited,
      coverage: pageViewCoverage(view.offset, unresolvedRows.length, total),
    });
  }
  const selected = canonicalJson(source.procedure);
  const endpoint = (value: z.infer<typeof procedureIdentitySchema> | null) =>
    value === null
      ? { kind: "null" as const }
      : jsonValueByteLength(value as JsonValue, PAGE_BYTES) <= PAGE_BYTES &&
          canonicalJson(value) === selected
        ? { kind: "selected-procedure" as const }
        : { kind: "inline" as const, value };
  for (const [index, reference] of source.references.entries()) {
    if (
      (view.source_address !== undefined &&
        reference.source_address !== view.source_address) ||
      (view.target_address !== undefined &&
        reference.target_address !== view.target_address)
    )
      continue;
    if (
      total >= view.offset &&
      referenceRows.length < view.limit &&
      !byteLimited
    ) {
      const row = {
        ...reference,
        source_index: index,
        source_procedure: endpoint(reference.source_procedure),
        target_procedure: endpoint(reference.target_procedure),
      };
      if (offer(row as JsonValue)) referenceRows.push(row);
    }
    total++;
  }
  if (byteLimited && referenceRows.length === 0) return tooLarge();
  return ok({
    ...common,
    view,
    items: { collection: "references" as const, rows: referenceRows },
    byte_limited: byteLimited,
    coverage: pageViewCoverage(view.offset, referenceRows.length, total),
  });
};
