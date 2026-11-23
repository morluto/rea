import { AnalysisInputError } from "../analysisErrorCore.js";
import type { ManagedParseIssue } from "./managedArtifact.js";

/** Header facts admitted before an unsupported table layout was identified. */
export interface ManagedMetadataHeaderFacts {
  readonly version: string;
  readonly streamNames: readonly string[];
}

/** Bounded format or applicability failure retained as managed coverage. */
export class ManagedReaderFailure extends Error {
  readonly metadataHeader: ManagedMetadataHeaderFacts | null;

  constructor(
    readonly issue: ManagedParseIssue,
    options?: ErrorOptions & {
      readonly metadataHeader?: ManagedMetadataHeaderFacts;
    },
  ) {
    super(issue.detail, options);
    this.metadataHeader = options?.metadataHeader ?? null;
  }
}

/** Refuse a heap-dependent row whose shared stream issue is reported by layout inventory. */
export class ManagedHeapAmbiguityFailure extends ManagedReaderFailure {}

/** A resource or unsupported layout leaves metadata unknown, not malformed. */
export const managedMetadataFailureStatus = (
  issue: ManagedParseIssue,
): "partial" | "malformed" =>
  issue.code === "resource-limit" || issue.code === "unsupported-metadata"
    ? "partial"
    : "malformed";

/** Malformed selected metadata is input failure for every inspection workflow. */
export const managedInspectionInputFailure = (
  operation: string,
  path: string,
  cause: unknown,
  inputField: "path" | "leftPath" | "rightPath" = "path",
): AnalysisInputError | undefined =>
  cause instanceof ManagedReaderFailure &&
  managedMetadataFailureStatus(cause.issue) === "malformed"
    ? new AnalysisInputError(operation, { cause }, [
        {
          path: [inputField],
          reason: "invalid_format",
          message: `Selected artifact ${path}: ${cause.issue.detail}`,
        },
      ])
    : undefined;

/** Construct a typed managed parse failure at an exact byte location. */
export const managedFailure = (
  code: ManagedParseIssue["code"],
  scope: string,
  detail: string,
  offset: number | null = null,
): ManagedReaderFailure =>
  new ManagedReaderFailure({ code, scope, offset, detail });

/** Retain a local malformed fact; capacity and unexpected failures still escape. */
export const retainManagedValueFailure = (
  cause: unknown,
  issues: ManagedParseIssue[],
): ManagedReaderFailure => {
  if (
    !(cause instanceof ManagedReaderFailure) ||
    managedMetadataFailureStatus(cause.issue) === "partial"
  )
    throw cause;
  if (!(cause instanceof ManagedHeapAmbiguityFailure)) issues.push(cause.issue);
  return cause;
};

/** Retain one malformed item's location while allowing independent items to be read. */
export const readManagedValue = <Value>(
  operation: () => Value,
  issues: ManagedParseIssue[],
): Value | undefined => {
  try {
    return operation();
  } catch (cause: unknown) {
    retainManagedValueFailure(cause, issues);
    return undefined;
  }
};

/** Preserve issue order while collapsing the same malformed producer fact across facets. */
export const uniqueManagedParseIssues = (
  issues: readonly ManagedParseIssue[],
): readonly ManagedParseIssue[] => [
  ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values(),
];

/**
 * Append issue lists one issue at a time. Spreading a list into `push` passes
 * one argument per issue, which overflows the stack on large malformed inputs.
 */
export const appendManagedParseIssues = (
  issues: ManagedParseIssue[],
  ...found: readonly (readonly ManagedParseIssue[])[]
): void => {
  for (const list of found) for (const issue of list) issues.push(issue);
};
