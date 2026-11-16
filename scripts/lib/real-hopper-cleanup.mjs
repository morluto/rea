import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Observe possible sessions and target leases without discarding uncertainty. */
export async function snapshotHopperRuntime(
  parent,
  targetLeaseDirectory,
  expectedRunId,
) {
  const paths = new Set();
  const confirmedSessions = new Set();
  const unresolvedSessions = new Set();
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const path = join(parent, entry.name);
    if (!entry.name.startsWith("rea-") || path === targetLeaseDirectory)
      continue;
    const confirmed =
      typeof expectedRunId === "string" &&
      expectedRunId.length > 0 &&
      entry.isDirectory() &&
      (await hasRunIdentity(path, expectedRunId));
    (confirmed ? confirmedSessions : unresolvedSessions).add(path);
    paths.add(path);
  }
  const leaseRoot = await lstat(targetLeaseDirectory).catch(missingIsAbsent);
  if (leaseRoot !== undefined) {
    if (!leaseRoot.isDirectory() || leaseRoot.isSymbolicLink())
      paths.add(targetLeaseDirectory);
    else {
      const leases = await readdir(targetLeaseDirectory).catch(missingIsAbsent);
      for (const name of leases ?? [])
        paths.add(join(targetLeaseDirectory, name));
    }
  }
  return { paths, confirmedSessions, unresolvedSessions };
}

const missingIsAbsent = (cause) => {
  if (cause?.code === "ENOENT") return undefined;
  throw cause;
};

const hasRunIdentity = async (path, expectedRunId) => {
  const encoded = await readFile(join(path, "ownership.json"), "utf8").catch(
    missingIsAbsent,
  );
  if (encoded === undefined) return false;
  let ownership;
  try {
    ownership = JSON.parse(encoded);
  } catch (cause) {
    if (cause instanceof SyntaxError) return false;
    throw cause;
  }
  return (
    ownership !== null &&
    typeof ownership === "object" &&
    ownership.run_id === expectedRunId
  );
};
