import type { util, z } from "zod";
import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "./analysisErrorCore.js";
import { knownArgumentMistakeGuidance } from "./inputArgumentGuidance.js";

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
  if (issue.code === "invalid_union") {
    for (const branch of issue.errors) charge(32 + 32 * branch.length);
    if ("options" in issue && Array.isArray(issue.options))
      for (const value of issue.options)
        charge(typeof value === "string" ? 6 * value.length + 32 : 32);
  }
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
  // Branch issue paths are relative to the union; branches often agree.
  if (issue.code === "invalid_union") {
    // Unmatched discriminators and ambiguous unions have no branch issues.
    // Keep their outer failure instead of flattening it into an empty list.
    if (issue.errors.length === 0) {
      const expected =
        "options" in issue ? issue.options?.filter(isSafeExpected) : undefined;
      return [
        {
          path,
          reason:
            valueAtPath(input, path) === undefined
              ? "missing_argument"
              : "invalid_value",
          ...(expected === undefined ? {} : { expected }),
        },
      ];
    }
    // A union tag selects branches. When branches declare literal sets for one
    // tag property, only the branches accepting the supplied tag describe the
    // caller's mistake; sibling branches report unrelated field paths.
    const tagged = narrowUnionBranch(issue, path, input);
    if (tagged !== undefined) {
      if (tagged.branches.length === 0)
        return [
          {
            path: [...path, ...tagged.tagPath],
            reason: "invalid_value",
            expected: [...mergeTagLiterals(issue.errors, tagged.tagPath)],
          },
        ];
      return mergeAgreeingIssues(
        tagged.branches.flatMap((branchIssue) =>
          projectIssue(
            nestedIssue(issue, branchIssue, budget),
            input,
            budget,
            operation,
          ),
        ),
      );
    }
    return mergeAgreeingIssues(
      issue.errors.flatMap((branch) =>
        branch.flatMap((branchIssue) =>
          projectIssue(
            nestedIssue(issue, branchIssue, budget),
            input,
            budget,
            operation,
          ),
        ),
      ),
    );
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
      },
    ];
  return [
    {
      path,
      reason: "invalid_value",
      ...(issue.message.length > 0 ? { message: issue.message } : {}),
    },
  ];
};

const isSafeExpected = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const safeExpected = (value: unknown) =>
  isSafeExpected(value) ? value : "schema-defined value";

const isTagLiteralValue = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

const uniqueIssues = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputIssue[] => [
  ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values(),
];

const issuePath = (
  path: readonly (string | number | PropertyKey)[],
): readonly (string | number)[] =>
  path.filter(
    (part): part is string | number =>
      typeof part === "string" || typeof part === "number",
  );

const samePath = (
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean =>
  left.length === right.length &&
  left.every((part, index) => part === right[index]);

/** Collapse branch expectations that agree into one correction per path. */
const mergeAgreeingIssues = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputIssue[] => {
  const merged: AnalysisInputIssue[] = [];
  for (const issue of issues) {
    const index = merged.findIndex(
      (other) =>
        other.reason === issue.reason &&
        other.message === issue.message &&
        Array.isArray(other.expected) &&
        Array.isArray(issue.expected) &&
        samePath(other.path, issue.path),
    );
    const existing = index === -1 ? undefined : merged[index];
    if (
      existing === undefined ||
      !Array.isArray(existing.expected) ||
      !Array.isArray(issue.expected)
    ) {
      merged.push(issue);
    } else {
      merged[index] = {
        ...existing,
        expected: [...new Set([...existing.expected, ...issue.expected])],
      };
    }
  }
  return uniqueIssues(merged);
};

const isTagLiterals = (
  issue: z.core.$ZodIssue,
): issue is z.core.$ZodIssue & {
  readonly code: "invalid_value";
  readonly values: readonly util.Primitive[];
} => issue.code === "invalid_value" && issue.values.length > 0;

/** Property paths whose accepted literals differ between union branches. */
const taggedFieldPaths = (
  issue: z.core.$ZodIssue & { readonly code: "invalid_union" },
): readonly (readonly (string | number)[])[] => {
  const paths = new Map<string, readonly (string | number)[]>();
  for (const branch of issue.errors)
    for (const branchIssue of flattenUnionBranches(branch)) {
      if (!isTagLiterals(branchIssue)) continue;
      const path = issuePath(branchIssue.path);
      paths.set(JSON.stringify(path), path);
    }
  return [...paths.values()];
};

/** Nested unions inside a branch report their own literals one level down. */
const flattenUnionBranches = (
  branch: readonly z.core.$ZodIssue[],
): readonly z.core.$ZodIssue[] =>
  branch.flatMap((branchIssue) =>
    branchIssue.code === "invalid_union" && branchIssue.errors.length > 0
      ? branchIssue.errors.flat().map((nested) => ({
          ...nested,
          path: [...issuePath(branchIssue.path), ...nested.path],
        }))
      : [branchIssue],
  );

const branchTagLiterals = (
  branch: readonly z.core.$ZodIssue[],
  tagPath: readonly (string | number)[],
): readonly (string | number)[] | undefined => {
  const declared = flattenUnionBranches(branch)
    .filter(
      (branchIssue) =>
        isTagLiterals(branchIssue) &&
        samePath(issuePath(branchIssue.path), tagPath),
    )
    .flatMap((branchIssue) =>
      branchIssue.code === "invalid_value"
        ? branchIssue.values.filter(isTagLiteralValue)
        : [],
    );
  return declared.length === 0 ? undefined : declared;
};

/** Literals any branch declares for one tag property, in schema order. */
const mergeTagLiterals = (
  branches: readonly (readonly z.core.$ZodIssue[])[],
  tagPath: readonly (string | number)[],
): readonly (string | number)[] => [
  ...new Set(
    branches.flatMap((branch) => branchTagLiterals(branch, tagPath) ?? []),
  ),
];

/**
 * Keep the diagnostics from branches whose tag literals accept the supplied
 * tag, dropping the tag rejection they all share. Undefined means no tag
 * discriminates the branches.
 */
const narrowUnionBranch = (
  issue: z.core.$ZodIssue & { readonly code: "invalid_union" },
  path: readonly (string | number)[],
  input: unknown,
):
  | {
      readonly branches: readonly z.core.$ZodIssue[];
      readonly tagPath: readonly (string | number)[];
    }
  | undefined => {
  const supplied = valueAtPath(input, path);
  if (typeof supplied !== "object" || supplied === null) return undefined;
  const candidates: {
    readonly branches: readonly z.core.$ZodIssue[];
    readonly tagPath: readonly (string | number)[];
  }[] = [];
  let preferred: (typeof candidates)[number] | undefined;
  for (const tagPath of taggedFieldPaths(issue)) {
    const tag = valueAtPath(supplied, tagPath);

    if (typeof tag !== "string" && typeof tag !== "number") continue;
    const literals = issue.errors.map((branch) =>
      branchTagLiterals(branch, tagPath),
    );
    const accepts = (values: readonly (string | number)[] | undefined) =>
      values === undefined || values.includes(tag);
    const accepting = literals
      .map((values, index) => ({ values, index }))
      .filter(({ values }) => accepts(values));
    // A property selects branches when the branches declaring its literals
    // agree on which tag they accept and at least one rejects the supplied tag.
    // A branch reporting the property for an unrelated reason (an unusable
    // value rather than a literal mismatch) is not part of that selector.
    if (
      !literals.some((values) => values !== undefined && !values.includes(tag))
    )
      continue;
    if (accepting.length === issue.errors.length) continue;
    const unrelated = issue.errors.some((branch, index) => {
      const declared = literals[index];
      if (declared !== undefined) return false;
      return branch.some(
        (branchIssue) =>
          samePath(issuePath(branchIssue.path), tagPath) &&
          branchIssue.code !== "invalid_value",
      );
    });
    if (unrelated) continue;
    const candidate = {
      branches: accepting.flatMap(
        ({ index }) =>
          issue.errors[index]?.filter(
            (branchIssue) => !samePath(issuePath(branchIssue.path), tagPath),
          ) ?? [],
      ),
      tagPath,
    };
    // A property no branch accepts is an ordinary field that failed everywhere,
    // not the union's discriminator. Prefer a property at least one branch
    // selects through, so the caller is not sent to values declared by a branch
    // the union never selects.
    if (accepting.length > 0 && preferred === undefined) preferred = candidate;
    candidates.push(candidate);
  }
  return preferred ?? candidates[0];
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

const boundedIssue = (
  path: readonly (string | number)[],
  key: "minimum" | "maximum",
  value: number | undefined,
): AnalysisInputIssue => ({
  path,
  reason: "out_of_range",
  ...(value === undefined ? {} : { [key]: value }),
});
