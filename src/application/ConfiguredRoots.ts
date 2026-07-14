import { realpath } from "node:fs/promises";

/** Canonicalize configured policy roots while ignoring stale missing entries. */
export const canonicalizeConfiguredRoots = async (
  roots: readonly string[],
): Promise<string[]> => {
  const canonical: string[] = [];
  for (const root of roots) {
    try {
      canonical.push(await realpath(root));
    } catch (cause: unknown) {
      if (!isMissingPath(cause)) throw cause;
    }
  }
  return canonical;
};

const isMissingPath = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
