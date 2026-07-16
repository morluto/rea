import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";

/** Immutable target copy admitted to one ephemeral Ghidra import. */
export interface GhidraTargetSnapshot {
  readonly path: string;
  readonly sha256: string;
}

/** Copy one target and require its bytes to match the parsed target identity. */
export const createGhidraTargetSnapshot = async (
  sourcePath: string,
  runtimeRoot: string,
  expectedSha256: string,
): Promise<GhidraTargetSnapshot> => {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256))
    throw new TypeError("Ghidra target SHA-256 commitment is invalid");
  const suffix = safeExtension(sourcePath);
  const snapshotPath = join(
    runtimeRoot,
    `target-${expectedSha256.slice(0, 12)}${suffix}`,
  );
  try {
    await copyFile(sourcePath, snapshotPath, constants.COPYFILE_EXCL);
    await chmod(snapshotPath, 0o600);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(snapshotPath))
      hash.update(chunk);
    const observedSha256 = hash.digest("hex");
    if (observedSha256 !== expectedSha256)
      throw new Error(
        `Ghidra target snapshot digest mismatch: expected ${expectedSha256}, observed ${observedSha256}`,
      );
    return { path: snapshotPath, sha256: observedSha256 };
  } catch (cause: unknown) {
    await rm(snapshotPath, { force: true }).catch(() => undefined);
    throw cause;
  }
};

const safeExtension = (path: string): string => {
  const extension = extname(path);
  return /^\.[A-Za-z0-9]{1,12}$/u.test(extension) ? extension : ".bin";
};
