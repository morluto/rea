import type { z } from "zod";
import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "./analysisErrorCore.js";
import {
  knownArgumentMistakeGuidance,
  knownViewMistakeGuidance,
} from "./inputArgumentGuidance.js";

const isRootArgument = (path: readonly unknown[]): boolean =>
  path.length === 0 || (path.length === 1 && path[0] === "input");

/** Build the standard application input error while retaining schema causes and extra semantic issues. */
export const analysisInputErrorFromIssues = (
  operation: string,
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  options: {
    readonly cause?: unknown;
    readonly userMessage?: string;
    readonly additionalIssues?: readonly AnalysisInputIssue[];
  } = {},
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.userMessage === undefined
        ? {}
        : { userMessage: options.userMessage }),
    },
    [
      ...projectInputIssues(issues, input, operation),
      ...(options.additionalIssues ?? []),
    ],
  );

/** Remove only the internal operation/input envelope from caller correction paths. */
export const analysisOperationInputErrorFromIssues = (
  operation: string,
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  cause: unknown,
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    { cause },
    projectInputIssues(issues, { operation, input }, operation).map((issue) =>
      issue.path[0] === "input"
        ? { ...issue, path: issue.path.slice(1) }
        : issue,
    ),
  );

/** Project Zod failures to secret-safe caller correction metadata. */
export const projectInputIssues = (
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  operation?: string,
): readonly AnalysisInputIssue[] =>
  issues.flatMap((issue) => projectIssue(issue, input, undefined, operation));

const projectionBudgetExceeded = Symbol(
  "input issue projection budget exceeded",
);

/** Field diagnostics that fit a byte allowance, plus what was dropped. */
export interface BoundedInputIssues {
  readonly issues: readonly AnalysisInputIssue[];
  /** Validator issues whose field diagnostics did not fit the allowance. */
  readonly omittedIssueCount: number;
}

/**
 * Project as many validator issues as fit, in one forward pass, and count the
 * rest. A single pass keeps the returned group maximal: it stops exactly at the
 * allowance instead of at a coarse fraction of the list, and a compound issue
 * such as `unrecognized_keys` still charges every field diagnostic it expands
 * into because the recursion goes through `projectIssue` per nested issue.
 */
export const projectInputIssuesBounded = (
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  budgetBytes: number,
): BoundedInputIssues => {
  const budget = { remaining: budgetBytes };
  const output: AnalysisInputIssue[] = [];
  let index = 0;
  try {
    for (; index < issues.length; index += 1) {
      const issue = issues[index];
      if (issue === undefined) continue;
      output.push(...projectIssue(issue, input, budget));
    }
  } catch (error) {
    if (error !== projectionBudgetExceeded) throw error;
    // The issue that crossed the allowance and every later one contribute at
    // least one omitted field diagnostic each.
    const omittedIssueCount = issues.length - index;
    if (output.length > 0) return { issues: output, omittedIssueCount };
    // One compound issue, such as `unrecognized_keys` naming hundreds of keys,
    // can exceed the allowance on its own. Retain a diagnostic at its path so the
    // caller keeps the location instead of only an omission notice.
    const first = issues[0];
    if (first === undefined) return { issues: output, omittedIssueCount };
    const path = first.path.flatMap((part) =>
      typeof part === "string" || typeof part === "number" ? [part] : [],
    );
    return {
      issues: [
        {
          path,
          reason: "invalid_value",
          message: `${String(omittedIssueCount)} field diagnostics at this location were omitted because they do not fit the response budget.`,
        },
      ],
      omittedIssueCount,
    };
  }
  return { issues: output, omittedIssueCount: 0 };
};

/** Retain each projected issue's source through bounded SDK normalization. */
export const projectInputIssueGroupsWithinBudget = (
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
  budgetBytes: number,
  operation?: string,
): readonly (readonly AnalysisInputIssue[])[] | undefined => {
  const budget = { remaining: budgetBytes };
  try {
    const groups: (readonly AnalysisInputIssue[])[] = [];
    for (const issue of issues)
      groups.push(projectIssue(issue, input, budget, operation));
    return groups;
  } catch (error) {
    if (error === projectionBudgetExceeded) return undefined;
    throw error;
  }
};

const chargeUnionProjection = (
  issue: Extract<z.core.$ZodIssue, { code: "invalid_union" }>,
  charge: (amount: number) => void,
): void => {
  for (const branch of issue.errors) charge(32 + 32 * branch.length);
  if ("options" in issue && Array.isArray(issue.options))
    for (const value of issue.options)
      charge(typeof value === "string" ? 6 * value.length + 32 : 32);
  if ("discriminator" in issue && typeof issue.discriminator === "string")
    charge(6 * issue.discriminator.length + 16);
};

const chargeProjection = (
  issue: z.core.$ZodIssue,
  budget: { remaining: number },
  operation?: string,
  input?: unknown,
): void => {
  // Six bytes per UTF-16 code unit covers JSON escaping. The fixed allowance
  // covers the projected object, property names, scalar values and delimiters.
  const charge = (amount: number) => {
    budget.remaining -= amount;
    if (budget.remaining < 0) throw projectionBudgetExceeded;
  };
  charge(256);
  let pathCost = 0;
  for (const part of issue.path) {
    const cost = typeof part === "string" ? 6 * part.length + 16 : 32;
    pathCost += cost;
    charge(cost);
  }
  charge(6 * issue.message.length);
  const viewGuidance = knownViewMistakeGuidance(
    operation,
    input,
    issue.path.flatMap((part) =>
      typeof part === "string" || typeof part === "number" ? [part] : [],
    ),
  );
  if (viewGuidance !== undefined) charge(6 * viewGuidance.message.length);
  if (issue.code === "invalid_union") chargeUnionProjection(issue, charge);
  if (issue.code === "invalid_key") charge(32 * issue.issues.length);
  if (issue.code === "unrecognized_keys")
    for (const key of issue.keys) {
      charge(256 + pathCost + 6 * key.length);
      if (isRootArgument(issue.path)) {
        const guidance = knownArgumentMistakeGuidance(operation, key);
        const expectedAlreadyPresent =
          guidance !== undefined &&
          valueAtPath(input, [...issue.path, guidance.expected]) !== undefined;
        if (guidance !== undefined && !expectedAlreadyPresent)
          charge(
            6 * guidance.expected.length + 6 * guidance.message.length + 32,
          );
      }
    }
  if (issue.code === "invalid_value")
    for (const value of issue.values)
      charge(typeof value === "string" ? 6 * value.length + 32 : 32);
};

const nestedIssue = (
  parent: z.core.$ZodIssue,
  child: z.core.$ZodIssue,
  budget: { remaining: number } | undefined,
): z.core.$ZodIssue => {
  if (budget !== undefined) {
    // The combined path is allocated before the child is projected. Charge
    // its references first so a long nested path cannot bypass the allowance.
    budget.remaining -= 32 + 8 * (parent.path.length + child.path.length);
    if (budget.remaining < 0) throw projectionBudgetExceeded;
  }
  return { ...child, path: [...parent.path, ...child.path] };
};

const projectUnrecognizedKeyIssues = (
  keys: readonly string[],
  path: readonly (string | number)[],
  input: unknown,
  operation?: string,
): readonly AnalysisInputIssue[] =>
  keys.map((key) => {
    const guidance = isRootArgument(path)
      ? knownArgumentMistakeGuidance(operation, key)
      : undefined;
    const expectedAlreadyPresent =
      guidance !== undefined &&
      valueAtPath(input, [...path, guidance.expected]) !== undefined;
    const effectiveGuidance = expectedAlreadyPresent ? undefined : guidance;
    return {
      path: [...path, key],
      reason: "unknown_argument" as const,
      ...(effectiveGuidance === undefined
        ? {}
        : {
            expected: effectiveGuidance.expected,
            message: effectiveGuidance.message,
          }),
    };
  });

const CANDIDATE_DISCRIMINATOR_KEYS: readonly string[] = [
  "kind",
  "type",
  "collection",
  "projection",
  "facet",
  "format",
  "source",
];

const candidateDiscriminatorKeys = (targetValue: object): readonly string[] => [
  ...CANDIDATE_DISCRIMINATOR_KEYS.filter((k) => k in targetValue),
  ...Object.keys(targetValue).filter(
    (k) => !(CANDIDATE_DISCRIMINATOR_KEYS as readonly string[]).includes(k),
  ),
];

const branchIssuesForRelativeKey = (
  branchErrors: readonly z.core.$ZodIssue[],
  key: string,
): readonly z.core.$ZodIssue[] => {
  const result: z.core.$ZodIssue[] = [];
  for (const err of branchErrors) {
    if (err.path.length === 1 && err.path[0] === key) {
      result.push(err);
    } else if (err.code === "invalid_union" && err.path.length === 0) {
      for (const nestedBranch of err.errors) {
        result.push(...branchIssuesForRelativeKey(nestedBranch, key));
      }
    }
  }
  return result;
};

const extractBranchExpectedValues = (
  issues: readonly z.core.$ZodIssue[],
): readonly unknown[] =>
  issues.flatMap((issue) => {
    if ("values" in issue && Array.isArray(issue.values)) return issue.values;
    if ("options" in issue && Array.isArray(issue.options))
      return issue.options;
    if ("expected" in issue && issue.expected !== undefined)
      return [issue.expected];
    return [];
  });

const resolveUnionDiscriminatorDiagnostic = (
  currentErrors: readonly (readonly z.core.$ZodIssue[])[],
  path: readonly (string | number)[],
  targetValue: object,
  budget?: { remaining: number },
): readonly AnalysisInputIssue[] | undefined => {
  const candidateKeys = candidateDiscriminatorKeys(targetValue);
  for (const key of candidateKeys) {
    const allBranchesRejectWithInvalidValue = currentErrors.every((branch) => {
      const issues = branchIssuesForRelativeKey(branch, key);
      return (
        issues.length > 0 &&
        issues.every((branchIssue) => branchIssue.code === "invalid_value")
      );
    });
    if (!allBranchesRejectWithInvalidValue) continue;
    const allKeyIssues = currentErrors.flatMap((branch) =>
      branchIssuesForRelativeKey(branch, key),
    );
    const uniqueExpected = [
      ...new Set(
        extractBranchExpectedValues(allKeyIssues).filter(isSafeExpected),
      ),
    ];
    if (uniqueExpected.length === 0) continue;
    if (budget !== undefined) {
      budget.remaining -= 32 + 8 * (path.length + 1);
      for (const item of uniqueExpected) {
        budget.remaining -=
          typeof item === "string" ? 6 * item.length + 32 : 32;
      }
      if (budget.remaining < 0) throw projectionBudgetExceeded;
    }
    return [
      {
        path: [...path, key],
        reason: "invalid_value",
        expected: uniqueExpected,
      },
    ];
  }
  return undefined;
};

const narrowUnionBranches = (
  errors: readonly (readonly z.core.$ZodIssue[])[],
  targetValue: object,
): readonly (readonly z.core.$ZodIssue[])[] => {
  let currentErrors = errors;
  const candidateKeys = candidateDiscriminatorKeys(targetValue);
  for (const key of candidateKeys) {
    const matchingBranches = currentErrors.filter(
      (branch) => branchIssuesForRelativeKey(branch, key).length === 0,
    );
    if (
      matchingBranches.length > 0 &&
      matchingBranches.length < currentErrors.length
    ) {
      currentErrors = matchingBranches;
      if (currentErrors.length === 1) break;
    }
  }
  return currentErrors;
};

interface UnionProjectionContext {
  readonly input: unknown;
  readonly projectChildIssue: (
    child: z.core.$ZodIssue,
  ) => readonly AnalysisInputIssue[];
  readonly budget?: { remaining: number } | undefined;
}

const projectUnionIssue = (
  issue: Extract<z.core.$ZodIssue, { code: "invalid_union" }>,
  path: readonly (string | number)[],
  context: UnionProjectionContext,
): readonly AnalysisInputIssue[] => {
  const { input, projectChildIssue, budget } = context;
  if (issue.errors.length === 0) {
    const targetPath =
      "discriminator" in issue &&
      typeof issue.discriminator === "string" &&
      path.at(-1) !== issue.discriminator
        ? [...path, issue.discriminator]
        : path;
    const expected =
      "options" in issue && Array.isArray(issue.options)
        ? issue.options.filter(isSafeExpected)
        : undefined;
    return [
      {
        path: targetPath,
        reason:
          valueAtPath(input, targetPath) === undefined
            ? "missing_argument"
            : "invalid_value",
        ...(expected === undefined ? {} : { expected }),
      },
    ];
  }

  const targetValue = valueAtPath(input, path);
  let activeErrors: readonly (readonly z.core.$ZodIssue[])[] = issue.errors;
  if (
    typeof targetValue === "object" &&
    targetValue !== null &&
    !Array.isArray(targetValue)
  ) {
    const discriminatorDiagnostic = resolveUnionDiscriminatorDiagnostic(
      issue.errors,
      path,
      targetValue,
      budget,
    );
    if (discriminatorDiagnostic !== undefined) return discriminatorDiagnostic;
    activeErrors = narrowUnionBranches(issue.errors, targetValue);
  }

  return uniqueIssues(
    activeErrors.flatMap((branch) =>
      branch.flatMap((branchIssue) =>
        projectChildIssue(nestedIssue(issue, branchIssue, budget)),
      ),
    ),
  );
};

const projectIssue = (
  issue: z.core.$ZodIssue,
  input: unknown,
  budget?: { remaining: number },
  operation?: string,
): readonly AnalysisInputIssue[] => {
  if (budget !== undefined) chargeProjection(issue, budget, operation, input);
  const path = issue.path.flatMap((part) =>
    typeof part === "string" || typeof part === "number" ? [part] : [],
  );
  const viewGuidance = knownViewMistakeGuidance(operation, input, path);
  // Branch issue paths are relative to the union; branches often agree.
  if (issue.code === "invalid_union") {
    return projectUnionIssue(issue, path, {
      input,
      projectChildIssue: (child) =>
        projectIssue(child, input, budget, operation),
      budget,
    });
  }
  if (issue.code === "invalid_key")
    return issue.issues.flatMap((keyIssue) =>
      projectIssue(
        nestedIssue(issue, keyIssue, budget),
        input,
        budget,
        operation,
      ),
    );
  if (issue.code === "unrecognized_keys")
    return projectUnrecognizedKeyIssues(issue.keys, path, input, operation);
  if (issue.code === "invalid_type")
    return [
      {
        path,
        reason:
          valueAtPath(input, path) === undefined
            ? "missing_argument"
            : "invalid_type",
        expected: safeExpected(issue.expected),
        ...(viewGuidance !== undefined
          ? { message: viewGuidance.message }
          : {}),
      },
    ];
  if (issue.code === "too_small")
    return [boundedIssue(path, "minimum", numericBound(issue.minimum))];
  if (issue.code === "too_big")
    return [boundedIssue(path, "maximum", numericBound(issue.maximum))];
  if (issue.code === "invalid_format")
    return [
      {
        path,
        reason: "invalid_format",
        expected: issue.format,
        ...(issue.format === "regex" && issue.message.length > 0
          ? { message: issue.message }
          : {}),
      },
    ];
  if (issue.code === "invalid_value")
    return [
      {
        path,
        reason: "invalid_value",
        expected: issue.values.filter(isSafeExpected),
        ...(viewGuidance !== undefined
          ? { message: viewGuidance.message }
          : {}),
      },
    ];
  return [
    {
      path,
      reason: "invalid_value",
      ...(viewGuidance !== undefined
        ? { message: viewGuidance.message }
        : issue.message.length > 0
          ? { message: issue.message }
          : {}),
    },
  ];
};

const mergeExpectedValues = (
  first: unknown,
  second: unknown,
): (string | number | boolean | null)[] => [
  ...new Set(
    [
      ...(Array.isArray(first) ? first : [first]),
      ...(Array.isArray(second) ? second : [second]),
    ].filter(isSafeExpected),
  ),
];

const uniqueIssues = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputIssue[] => {
  const merged: AnalysisInputIssue[] = [];
  const invalidValueIndexByPath = new Map<string, number>();

  for (const issue of issues) {
    const pathKey = JSON.stringify(issue.path);
    if (issue.reason === "invalid_value" && issue.expected !== undefined) {
      const existingIndex = invalidValueIndexByPath.get(pathKey);
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex];
        if (existing !== undefined) {
          merged[existingIndex] = {
            ...existing,
            expected: mergeExpectedValues(existing.expected, issue.expected),
            ...((existing.message ?? issue.message)
              ? { message: existing.message ?? issue.message }
              : {}),
          };
          continue;
        }
      }
      invalidValueIndexByPath.set(pathKey, merged.length);
    }
    const fullKey = JSON.stringify(issue);
    if (!merged.some((m) => JSON.stringify(m) === fullKey)) {
      merged.push(issue);
    }
  }
  return merged;
};

const valueAtPath = (input: unknown, path: readonly PropertyKey[]): unknown => {
  let current = input;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    const next: unknown = Reflect.get(current, part);
    current = next;
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
