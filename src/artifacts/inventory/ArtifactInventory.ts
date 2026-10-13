import { realpath } from "node:fs/promises";

import {
  artifactInventoryOutputSchema,
  type ArtifactInventoryOutput,
} from "../../domain/artifactGraph.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { scanCanonicalArtifactInventoryInScope } from "./scanCanonical.js";
import type { ArtifactInventoryOptions } from "./types.js";
import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";

/** Inventory one local artifact and return every graph collection inline. */
export const inventoryArtifact = async (
  inputPath: string,
  options: ArtifactInventoryOptions,
): Promise<ArtifactInventoryOutput> => {
  const snapshot = await scanArtifactInventory(inputPath, options);
  return artifactInventoryOutputSchema.parse(snapshot);
};

/** Scan an artifact once and retain the complete immutable graph for projection. */
export const scanArtifactInventory = async (
  inputPath: string,
  options: ArtifactInventoryOptions,
): Promise<ArtifactInventorySnapshot> =>
  options.resourceScope.run(() =>
    scanArtifactInventoryInScope(inputPath, options),
  );

export const scanArtifactInventoryInScope = async (
  inputPath: string,
  options: ArtifactInventoryOptions,
): Promise<ArtifactInventorySnapshot> => {
  abortIfNeeded(options.signal);
  const path = await realpath(inputPath);
  return scanCanonicalArtifactInventoryInScope(path, options);
};
