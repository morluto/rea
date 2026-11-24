import { z } from "zod";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  jsonStringByteLength,
  truncateJsonString,
} from "./jsonStringByteLength.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";

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

/** Configuration for projecting a validation failure inside a delivered byte allowance. */
export interface BoundedValidationFailureOptions {
  readonly budgetBytes: number;
  readonly within?: readonly (string | number)[];
  readonly descriptionCopies?: number;
}

/** Schema validation summary bounded to a fixed diagnostic byte allowance. */
export interface BoundedValidationFailure {
  readonly description: string;
  readonly issuePath?: readonly (string | number)[];
  readonly constraint?: string;
  readonly remainingIssueCount?: number;
}

const OMITTED_NESTED_PATH_NOTE =
  " (nested path omitted because it exceeds the diagnostic budget)";
const OMITTED_ROOT_PATH_NOTE =
  "the document root (full path omitted because it exceeds the diagnostic budget)";
const TRUNCATED_DETAIL_SUFFIX = " (truncated; exceeds diagnostic budget)";

const formatValidationDescription = (
  location: string,
  detail: string,
  remainingIssueCount: number,
): string =>
  `at ${location}: ${detail}${remainingIssueCount === 0 ? "" : ` (${String(remainingIssueCount)} more issues)`}`;

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
  return formatValidationDescription(
    location,
    first?.message ?? "invalid value",
    rest.length,
  );
};

/** Describe the first validation failure and its issue path within the remaining JSON budget. */
export const boundedValidationFailure = (
  cause: unknown,
  options: BoundedValidationFailureOptions,
): BoundedValidationFailure => {
  const copies = Math.max(1, options.descriptionCopies ?? 1);
  const budgetBytes = Math.max(0, options.budgetBytes);
  if (!(cause instanceof z.ZodError))
    return {
      description: truncateJsonString(
        errorMessage(cause),
        Math.floor(budgetBytes / copies),
        TRUNCATED_DETAIL_SUFFIX,
      ),
    };
  const issue = firstValidationIssue(cause);
  if (issue === undefined)
    return {
      description: formatValidationDescription(
        "the document root",
        "invalid value",
        0,
      ),
    };
  const firstMessage = cause.issues[0]?.message ?? "invalid value";
  const remainingSuffix =
    issue.remainingIssueCount === 0
      ? ""
      : ` (${String(issue.remainingIssueCount)} more issues)`;
  const proseOverhead =
    copies *
      (jsonStringByteLength(
        `at ${OMITTED_ROOT_PATH_NOTE}: ${remainingSuffix}`,
      ) -
        2) +
    (options.within === undefined ? 0 : 2);
  const usable = Math.max(0, budgetBytes - proseOverhead);
  const pathBudget = Math.floor(usable / 2);
  let remainingPath = pathBudget;
  const keptIssuePath: (string | number)[] = [];
  if (options.within !== undefined) {
    for (const part of options.within) {
      const elementBytes =
        (keptIssuePath.length === 0 ? 0 : 1) +
        jsonValueByteLength(part, remainingPath);
      if (elementBytes > remainingPath) break;
      remainingPath -= elementBytes;
      keptIssuePath.push(part);
    }
  }
  const keptLocation: (string | number)[] = [];
  let pathTruncated = false;
  for (const part of issue.path) {
    const issueSegmentBytes =
      options.within === undefined
        ? 0
        : (keptIssuePath.length === 0 ? 0 : 1) +
          jsonValueByteLength(part, remainingPath);
    const proseSegmentBytes =
      copies *
      ((keptLocation.length === 0 ? 0 : 1) +
        Math.max(0, jsonStringByteLength(String(part), remainingPath) - 2));
    const totalBytes = issueSegmentBytes + proseSegmentBytes;
    if (totalBytes > remainingPath) {
      pathTruncated = true;
      break;
    }
    remainingPath -= totalBytes;
    keptLocation.push(part);
    if (options.within !== undefined) keptIssuePath.push(part);
  }
  const usedPathBytes = pathBudget - remainingPath;
  let remainingDetail = Math.max(0, usable - usedPathBytes);
  let keptConstraint: string | undefined;
  if (issue.constraint !== undefined) {
    const constraintCap = Math.floor(remainingDetail / 4);
    const constraintBytes = jsonStringByteLength(
      issue.constraint,
      constraintCap,
    );
    if (constraintBytes <= constraintCap) {
      keptConstraint = issue.constraint;
      remainingDetail -= constraintBytes;
    }
  }
  const perCopyDetailLimit = Math.floor(remainingDetail / copies) + 2;
  const detail = truncateJsonString(
    firstMessage,
    perCopyDetailLimit,
    TRUNCATED_DETAIL_SUFFIX,
  );
  const baseLocation =
    keptLocation.length === 0 ? "the document root" : keptLocation.join(".");
  const location = !pathTruncated
    ? baseLocation
    : keptLocation.length === 0
      ? OMITTED_ROOT_PATH_NOTE
      : `${baseLocation}${OMITTED_NESTED_PATH_NOTE}`;
  return {
    description: formatValidationDescription(
      location,
      detail,
      issue.remainingIssueCount,
    ),
    ...(options.within === undefined ? {} : { issuePath: keptIssuePath }),
    ...(keptConstraint === undefined ? {} : { constraint: keptConstraint }),
    remainingIssueCount: issue.remainingIssueCount,
  };
};
