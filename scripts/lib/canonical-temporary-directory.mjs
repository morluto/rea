import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Allocate under a caller-selected parent and return the host's canonical spelling. */
export const createCanonicalTemporaryDirectory = async (
  prefix,
  parent = tmpdir(),
) => {
  const allocatedPath = await mkdtemp(join(parent, prefix));
  try {
    return { path: await realpath(allocatedPath), allocatedPath };
  } catch (cause) {
    await rm(allocatedPath, { recursive: true, force: true });
    throw cause;
  }
};
