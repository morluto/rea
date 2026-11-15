import { z } from "zod";

/** The location `describeValidationFailure` names, when the cause is schema-located. */
export const firstValidationIssuePath = (
  cause: unknown,
): readonly (string | number)[] | undefined => {
  if (!(cause instanceof z.ZodError)) return undefined;
  const first = cause.issues[0];
  return first?.path.map((key) =>
    typeof key === "number" ? key : String(key),
  );
};

/** Locate the first schema issue, or keep a thrown constraint message. */
export const describeValidationFailure = (cause: unknown): string => {
  if (!(cause instanceof z.ZodError))
    return cause instanceof Error ? cause.message : String(cause);
  const [first, ...rest] = cause.issues;
  const location =
    first === undefined || first.path.length === 0
      ? "the document root"
      : first.path.map(String).join(".");
  return `at ${location}: ${first?.message ?? "invalid value"}${rest.length === 0 ? "" : ` (${String(rest.length)} more issues)`}`;
};
