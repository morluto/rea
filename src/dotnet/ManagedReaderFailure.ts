import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";

/** Bounded format failure retained as caller-visible managed coverage. */
export class ManagedReaderFailure extends Error {
  constructor(
    readonly issue: ManagedParseIssue,
    options?: ErrorOptions,
  ) {
    super(issue.detail, options);
  }
}

/** Construct a typed managed parse failure at an exact byte location. */
export const managedFailure = (
  code: ManagedParseIssue["code"],
  scope: string,
  detail: string,
  offset: number | null = null,
): ManagedReaderFailure =>
  new ManagedReaderFailure({ code, scope, offset, detail });

/** Retain one malformed item's location while allowing independent items to be read. */
export const readManagedValue = <Value>(
  operation: () => Value,
  issues: ManagedParseIssue[],
): Value | undefined => {
  try {
    return operation();
  } catch (cause: unknown) {
    if (
      !(cause instanceof ManagedReaderFailure) ||
      cause.issue.code === "resource-limit"
    )
      throw cause;
    issues.push(cause.issue);
    return undefined;
  }
};

/** Preserve issue order while collapsing the same malformed producer fact across facets. */
export const uniqueManagedParseIssues = (
  issues: readonly ManagedParseIssue[],
): readonly ManagedParseIssue[] => [
  ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values(),
];
