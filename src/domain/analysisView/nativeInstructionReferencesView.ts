import { z } from "zod";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { nativeInstructionSchema } from "../native/nativeInstruction.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { jsonValueSchema, type JsonValue } from "../jsonValue.js";
import { err, ok } from "../result.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  boundedViewMessages,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { assertOwnedView, type AdmittedView } from "./analysisViewShape.js";

export const nativeInstructionReferencesRequestSchema = z.strictObject({
  kind: z.literal("native-instruction-references"),
  collection: z.enum(["references", "incoming_references"]),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
});
const rowSchema = z.strictObject({
  source_index: z.int().nonnegative(),
  value: nativeInstructionSchema.shape.references.element,
});
export const nativeInstructionReferenceItemsSchema = z.discriminatedUnion(
  "state",
  [
    z.strictObject({ state: z.literal("available"), rows: z.array(rowSchema) }),
    z.strictObject({ state: z.literal("unavailable"), rows: z.null() }),
    z.strictObject({ state: z.literal("not-recorded"), rows: z.null() }),
  ],
);
export const nativeInstructionReferenceContextSchema = z.strictObject({
  address: z.string(),
  status: nativeInstructionSchema.shape.status,
  procedure: z.string().nullable(),
});
const read = createAnalysisViewResultReader(nativeInstructionSchema);
// Reserve space for Evidence and MCP serialization expansion, as in other
// bounded native pages. An oversized individual row stays in the parent.
const PAGE_BYTES = 1024 * 1024;
const DIGEST_BYTES = jsonValueByteLength({ view_digest: "0".repeat(64) }) - 1;

export const projectNativeInstructionReferencesView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "native-instruction-references")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "Use native-instruction-references with this source.",
        },
      ]),
    );
  assertOwnedView<z.output<typeof nativeInstructionReferencesRequestSchema>>(
    view,
    "native-instruction-references",
  );
  const parsed = read(parent);
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  const values =
    view.collection === "references"
      ? source.references
      : source.incoming_references;
  const tooLarge = () =>
    err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "transport",
        "The selected instruction-reference view cannot fit the analysis-view byte budget.",
        { parent_evidence_id: parent.evidenceId, limit_bytes: PAGE_BYTES },
        {
          retryable: false,
          remediationAction:
            "An individual row or page context exceeds the 1,048,576-byte projection allowance. Retrieve or export the complete parent Evidence by ID, or read its local bundle.",
        },
      ),
    );
  // Parameters already belong to the authenticated parent; measure before
  // parsing their detached page representation.
  if (
    jsonValueByteLength((parent.parameters ?? null) as JsonValue, PAGE_BYTES) >
    PAGE_BYTES
  )
    return tooLarge();
  const common = {
    kind: "native-instruction-references" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_native_instruction" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    source_provider: parent.provider ?? null,
    source_analysis_profile_digest: parent.analysisProfile?.digest ?? null,
    source_parameters: jsonValueSchema.parse(parent.parameters ?? null),
    instruction: {
      address: source.address,
      status: source.status,
      procedure: source.procedure,
    },
    limitations: boundedViewMessages(
      [...parent.limitations, ...source.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Page coverage describes retained references, not provider discovery completeness or runtime execution.",
    ],
  };
  if (values === undefined || values === null) {
    const result = {
      ...common,
      items: {
        state:
          values === undefined
            ? ("not-recorded" as const)
            : ("unavailable" as const),
        rows: null,
      },
      coverage: null,
      byte_limited: false,
    };
    return jsonValueByteLength(result as JsonValue, PAGE_BYTES - DIGEST_BYTES) >
      PAGE_BYTES - DIGEST_BYTES
      ? tooLarge()
      : ok(result);
  }
  const header = {
    ...common,
    items: { state: "available", rows: [] },
    coverage: {
      status: "complete-within-view",
      examined: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
      next_offset: Number.MAX_SAFE_INTEGER,
      exhausted: false,
    },
    byte_limited: false,
  };
  let bytes =
    DIGEST_BYTES +
    jsonValueByteLength(header as JsonValue, PAGE_BYTES - DIGEST_BYTES);
  if (bytes > PAGE_BYTES) return tooLarge();
  const rows: z.infer<typeof rowSchema>[] = [];
  let byteLimited = false;
  for (
    let index = view.offset;
    index < values.length && rows.length < view.limit;
    index++
  ) {
    const row = { source_index: index, value: values[index]! };
    const size =
      jsonValueByteLength(row as JsonValue, PAGE_BYTES - bytes) +
      (rows.length === 0 ? 0 : 1);
    if (bytes + size > PAGE_BYTES) {
      byteLimited = true;
      break;
    }
    bytes += size;
    rows.push(row);
  }
  if (byteLimited && rows.length === 0) return tooLarge();
  return ok({
    ...common,
    items: { state: "available" as const, rows },
    coverage: pageViewCoverage(view.offset, rows.length, values.length),
    byte_limited: byteLimited,
  });
};
