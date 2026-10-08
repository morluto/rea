/** Observe concrete Hopper runtime resources for a before/after cleanup check. */
export function snapshotHopperRuntime(
  parent: string,
  targetLeaseDirectory: string,
): Promise<Set<string>>;
