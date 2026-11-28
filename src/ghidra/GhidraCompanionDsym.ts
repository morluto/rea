import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
  readArtifactFileChunks,
  withArtifactRegularFile,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { sameRegularFileState } from "../filesystem/RegularFile.js";

/** DWARF member inside a caller-selected sibling dSYM bundle. */
export const companionDwarfPath = (sourcePath: string): string =>
  join(
    `${sourcePath}.dSYM`,
    "Contents",
    "Resources",
    "DWARF",
    basename(sourcePath),
  );

/** Cancellation must escape optional-companion skip semantics. */
export const companionCancelled = (cause: unknown): boolean =>
  cause instanceof ArtifactReaderFailure && cause.reason === "cancelled";

/**
 * Commit the companion dSYM's content digest, or null when no readable, stable
 * sibling stages. The analysis profile owns this commitment so snapshots and
 * checkpoints cannot reuse results built without those symbols.
 */
export const ghidraCompanionDsymDigest = async (
  sourcePath: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string | null> => {
  const sourceDwarf = companionDwarfPath(sourcePath);
  try {
    if (!(await stat(sourceDwarf)).isFile()) return null;
    return await withArtifactRegularFile(
      sourceDwarf,
      resources,
      signal,
      async ({ handle: source }) => {
        const initial = await source.stat({ bigint: true });
        assertArtifactReadActive(signal);
        const hash = createHash("sha256");
        const input = readArtifactFileChunks(source, {
          end: initial.size,
          signal,
        });
        for await (const chunk of input) {
          assertArtifactReadActive(signal);
          hash.update(chunk);
        }
        if (
          input.readCoverage().kind !== "complete" ||
          !sameRegularFileState(initial, await source.stat({ bigint: true }))
        )
          return null;
        return hash.digest("hex");
      },
      "follow",
    );
  } catch (cause: unknown) {
    if (companionCancelled(cause)) throw cause;
    return null;
  }
};
