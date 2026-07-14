import { realpath } from "node:fs/promises";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { withinRoot } from "../reference/ReferenceSourceReaderPaths.js";
import {
  scanCanonicalArtifactInventory,
  type ArtifactIntegrityPolicy,
  type ArtifactInventorySnapshot,
} from "./ArtifactInventory.js";

/** Resolve, authorize, and scan one artifact without a second path resolution. */
export const scanAuthorizedArtifactInventory = async (
  inputPath: string,
  roots: readonly string[],
  limits: ArtifactLimits,
  signal?: AbortSignal,
  integrity?: ArtifactIntegrityPolicy,
): Promise<ArtifactInventorySnapshot> => {
  if (roots.length === 0)
    throw new ArtifactReaderFailure(
      "path",
      "Artifact input roots are disabled",
    );
  const [path, approved] = await Promise.all([
    realpath(inputPath),
    Promise.all(roots.map(async (root) => realpath(root))),
  ]);
  if (!approved.some((root) => withinRoot(root, path)))
    throw new ArtifactReaderFailure(
      "path",
      "Artifact path is outside approved input roots",
    );
  return scanCanonicalArtifactInventory(
    path,
    limits,
    signal,
    undefined,
    integrity,
  );
};
