import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vitest";

const TEMPORARY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*-$/u;

/** Creates a canonical temporary directory owned by the current Vitest case. */
export const createTestTempDirectory = async (
  prefix: string,
): Promise<string> => {
  if (!TEMPORARY_PREFIX.test(prefix) || prefix.length > 80) {
    throw new TypeError(
      "Test temporary directory prefixes must be safe basenames ending in '-'",
    );
  }

  const canonicalTemporaryRoot = await realpath(tmpdir());
  const created = await mkdtemp(join(canonicalTemporaryRoot, prefix));
  const canonicalDirectory = await realpath(created);

  onTestFinished(async () => {
    await rm(canonicalDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  return canonicalDirectory;
};
