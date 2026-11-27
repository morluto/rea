import type { z } from "zod";
import type { AnalysisInputError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { evidenceLocalTarget, type Evidence } from "../evidence.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { err, ok, type Result } from "../result.js";
import { ownedJsonValueSchema } from "../jsonValue.js";
import { EvidenceIntegrityError } from "../evidenceErrors.js";
import type { systemdJournalObjectHeaderSchema } from "../formatMetadata/androidAndSystemMetadata.js";

/** Bind a projected artifact to the parent subject when one is recorded. */
export const validateAnalysisViewSubject = (
  subject: Evidence["subject"] | undefined,
  artifactSha256: string | null | undefined,
): Result<void, EvidenceIntegrityError> => {
  const file = evidenceLocalTarget({ subject });
  return file === undefined || file.sha256 === artifactSha256
    ? ok(undefined)
    : err(
        new EvidenceIntegrityError(
          `Parent subject SHA-256 ${file.sha256} differs from analysis artifact SHA-256 ${artifactSha256 ?? "unknown"}.`,
        ),
      );
};

/** Parent record already resolved from inline Evidence or a session reference. */
/**
 * One row of a `format_record_headers` page. Owned here, beside the parent it
 * travels on, so projectors and the request hub never import each other.
 */
export type FormatRecordHeader = z.output<
  typeof systemdJournalObjectHeaderSchema
>;

export interface AnalysisViewParent {
  readonly evidenceId: string;
  readonly operation: string;
  readonly predicateType: string;
  readonly normalizedResult: unknown;
  readonly rawResult?: unknown;
  readonly provider?: Evidence["provider"];
  readonly analysisProfile?: Evidence["analysis_profile"];
  readonly authority?: Evidence["authority"];
  readonly environment?: Evidence["environment"];
  /** The owner proved normalizedResult belongs to a sealed, deep-frozen Evidence snapshot. */
  readonly sealedResult?: boolean;
  /** Subject presentation for this delivery, including explicit absence. */
  readonly subject?: Evidence["subject"];
  readonly limitations: readonly string[];
  readonly artifact?: { readonly path: string; readonly sha256: string } | null;
  /** Parent Evidence parameters, when the parent operation records them. */
  readonly parameters?: unknown;
  /** The complete authenticated parent record, for views that page its exact JSON. */
  readonly evidence?: Evidence;
  /**
   * A `format_record_headers` page the application re-read from the unchanged
   * root file, with the parent inventory's exact record total.
   */
  readonly formatRecordPage?: {
    readonly items: readonly FormatRecordHeader[];
    readonly total: number;
  };
}
import {
  canBorrowParsedJsonSnapshot,
  freezeOwnedJsonTreeSnapshot,
  isImmutableJsonSnapshot,
} from "../immutableJson.js";

/** One owning schema reuses validated immutable facts for their retained lifetime. */
export const createAnalysisViewResultReader = <Value>(parser: {
  readonly safeParse: (input: unknown) => z.ZodSafeParseResult<Value>;
}): ((parent: AnalysisViewParent) => Result<Value, AnalysisError>) => {
  const checked = new WeakMap<object, Value>();
  return (parent) => {
    const source = parent.normalizedResult;
    const reusable =
      parent.sealedResult === true &&
      typeof source === "object" &&
      source !== null &&
      isImmutableJsonSnapshot(source);
    const known = reusable ? checked.get(source) : undefined;
    if (known !== undefined) return ok(known);
    const parsed = parseAnalysisViewResult(parser, parent);
    if (!parsed.ok || !reusable) return parsed;
    if (canBorrowParsedJsonSnapshot(source, parsed.value)) {
      checked.set(source, source);
      return ok(source);
    }
    const normalized = ownedJsonValueSchema.safeParse(parsed.value);
    if (!normalized.success) return parsed;
    const frozen = freezeOwnedJsonTreeSnapshot(normalized.data) as Value;
    checked.set(source, frozen);
    return ok(frozen);
  };
};

/** Parse a parent's result with its owning parser; issues point into the view source. */
export const parseAnalysisViewResult = <Value>(
  parser: {
    readonly safeParse: (input: unknown) => z.ZodSafeParseResult<Value>;
  },
  parent: AnalysisViewParent,
): Result<Value, AnalysisError> => {
  const parsed = parser.safeParse(parent.normalizedResult);
  if (parsed.success) return ok(parsed.data);
  return err(
    analysisViewResultInputError(parent.normalizedResult, parsed.error),
  );
};

/** Locate schema failures inside the retained result, including throwing parsers. */
export const analysisViewResultInputError = (
  input: unknown,
  cause: z.ZodError,
): AnalysisInputError =>
  analysisInputErrorFromIssues(
    "inspect_analysis_view",
    cause.issues.map((issue) => ({
      ...issue,
      path: ["source", "normalized_result", ...issue.path],
    })),
    { source: { normalized_result: input } },
    { cause },
  );

/** Path named by a parent result, or the Evidence id when the result has none. */
export const parentArtifactPath = (parent: AnalysisViewParent): string => {
  if (
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null &&
    "artifact" in parent.normalizedResult &&
    typeof parent.normalizedResult.artifact === "object" &&
    parent.normalizedResult.artifact !== null &&
    "path" in parent.normalizedResult.artifact &&
    typeof parent.normalizedResult.artifact.path === "string"
  )
    return parent.normalizedResult.artifact.path;
  if (
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null &&
    "input_path" in parent.normalizedResult &&
    typeof parent.normalizedResult.input_path === "string"
  )
    return parent.normalizedResult.input_path;
  return parent.evidenceId;
};
