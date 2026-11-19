import { z } from "zod";
import { errorMessage } from "../kernel/errorMessage.js";

/**
 * What `describeValidationFailure` states in prose, as facts a caller can act
 * on without reading the description.
 */
export interface ValidationIssueFacts {
  /** The first issue's location. */
  readonly path: readonly (string | number)[];
  /** The constraint a custom refinement named on the first issue. */
  readonly constraint: string | undefined;
  /** Further issues the description summarizes as "(N more issues)". */
  readonly remainingIssueCount: number;
}

/** The first schema issue's facts, when the cause is a schema failure. */
export const firstValidationIssue = (
  cause: unknown,
): ValidationIssueFacts | undefined => {
  if (!(cause instanceof z.ZodError)) return undefined;
  const [first, ...rest] = cause.issues;
  if (first === undefined) return undefined;
  const constraint: unknown =
    first.code === "custom" ? first.params?.["constraint"] : undefined;
  return {
    path: first.path.map((key) =>
      typeof key === "number" ? key : String(key),
    ),
    constraint: typeof constraint === "string" ? constraint : undefined,
    remainingIssueCount: rest.length,
  };
};

/** Locate the first schema issue, or keep a thrown constraint message. */
export const describeValidationFailure = (cause: unknown): string => {
  if (!(cause instanceof z.ZodError)) return errorMessage(cause);
  const [first, ...rest] = cause.issues;
  const location =
    first === undefined || first.path.length === 0
      ? "the document root"
      : first.path.map(String).join(".");
  return `at ${location}: ${first?.message ?? "invalid value"}${rest.length === 0 ? "" : ` (${String(rest.length)} more issues)`}`;
};
