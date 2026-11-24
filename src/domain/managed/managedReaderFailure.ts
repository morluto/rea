import {
  AnalysisTargetFailureError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
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

/** The ParseFailure format of a managed PE/CLI image and its ECMA-335 metadata. */
export const MANAGED_PE_CLI_FORMAT = "pe-cli";

/**
 * The selected file's refusal when a managed reader stopped on its bytes.
 * The issue code is the reader's own classification: a layout or signature
 * form outside decoder coverage is an unsupported target, so a newer valid
 * file is never called corrupt, and every other code names a rule the bytes
 * broke, a malformed target. The request that selected the file is not at
 * fault either way. A resource limit names a budget only its producer knows,
 * so it and any other cause return `undefined`.
 */
export const managedInspectionTargetFailure = (
  operation: string,
  path: string,
  cause: unknown,
): AnalysisTargetFailureError | AnalysisUnsupportedTargetError | undefined => {
  if (!(cause instanceof ManagedReaderFailure)) return undefined;
  const { code, scope, offset, detail } = cause.issue;
  if (code === "resource-limit") return undefined;
  if (code === "unsupported-metadata" || code === "unsupported-signature")
    return new AnalysisUnsupportedTargetError(operation, path, detail, {
      cause,
    });
  return new AnalysisTargetFailureError(
    operation,
    path,
    {
      kind: "malformed",
      format: MANAGED_PE_CLI_FORMAT,
      detail,
      field: scope,
      ...(offset === null ? {} : { offset }),
    },
    { cause },
  );
};

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
