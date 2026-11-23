/** Observe possible Hopper resources, including entries with unresolved ownership. */
export function snapshotHopperRuntime(
  parent: string,
  targetLeaseDirectory: string,
  expectedRunId?: string,
): Promise<{
  readonly paths: Set<string>;
  readonly confirmedSessions: Set<string>;
  readonly unresolvedSessions: Set<string>;
}>;
