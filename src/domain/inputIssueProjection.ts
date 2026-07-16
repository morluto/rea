import type { z } from "zod";

import type { AnalysisInputIssue } from "./errors.js";

/** Project Zod failures to secret-safe caller correction metadata. */
export const projectInputIssues = (
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
): readonly AnalysisInputIssue[] =>
  issues.flatMap((issue) => projectIssue(issue, input));

const projectIssue = (
  issue: z.core.$ZodIssue,
  input: unknown,
): readonly AnalysisInputIssue[] => {
  const path = issue.path.flatMap((part) =>
    typeof part === "string" || typeof part === "number" ? [part] : [],
  );
  if (issue.code === "unrecognized_keys")
    return issue.keys.map((key) => ({
      path: [...path, key],
      reason: "unknown_argument" as const,
    }));
  if (issue.code === "invalid_type")
    return [
      {
        path,
        reason:
          valueAtPath(input, path) === undefined
            ? "missing_argument"
            : "invalid_type",
        expected: safeExpected(issue.expected),
      },
    ];
  if (issue.code === "too_small")
    return [boundedIssue(path, "minimum", numericBound(issue.minimum))];
  if (issue.code === "too_big")
    return [boundedIssue(path, "maximum", numericBound(issue.maximum))];
  if (issue.code === "invalid_format")
    return [{ path, reason: "invalid_format", expected: issue.format }];
  if (issue.code === "invalid_value")
    return [
      {
        path,
        reason: "invalid_value",
        expected: issue.values.filter(isSafeExpected),
      },
    ];
  return [{ path, reason: "invalid_value" }];
};

const valueAtPath = (
  input: unknown,
  path: readonly (string | number)[],
): unknown => {
  let current = input;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Readonly<Record<string | number, unknown>>)[part];
  }
  return current;
};

const numericBound = (value: number | bigint): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isSafeExpected = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const safeExpected = (value: unknown) =>
  isSafeExpected(value) ? value : "schema-defined value";

const boundedIssue = (
  path: readonly (string | number)[],
  key: "minimum" | "maximum",
  value: number | undefined,
): AnalysisInputIssue => ({
  path,
  reason: "out_of_range",
  ...(value === undefined ? {} : { [key]: value }),
});
