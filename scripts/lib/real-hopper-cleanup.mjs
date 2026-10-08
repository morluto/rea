import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Observe session paths and target leases without treating their shared parent as a session. */
export async function snapshotHopperRuntime(parent, targetLeaseDirectory) {
  const resources = new Set(
    (await readdir(parent))
      .filter((name) => name.startsWith("rea-"))
      .map((name) => join(parent, name))
      .filter((path) => path !== targetLeaseDirectory),
  );
  const leaseRoot = await lstat(targetLeaseDirectory).catch(missingIsAbsent);
  if (leaseRoot === undefined) return resources;
  if (!leaseRoot.isDirectory() || leaseRoot.isSymbolicLink()) {
    resources.add(targetLeaseDirectory);
    return resources;
  }
  const leases = await readdir(targetLeaseDirectory).catch(missingIsAbsent);
  for (const name of leases ?? [])
    resources.add(join(targetLeaseDirectory, name));
  return resources;
}

const missingIsAbsent = (cause) => {
  if (cause?.code === "ENOENT") return undefined;
  throw cause;
};
