import type { ManagedParseIssue } from "../domain/managedArtifact.js";

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
