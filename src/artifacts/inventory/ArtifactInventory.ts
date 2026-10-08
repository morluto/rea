import { realpath } from "node:fs/promises";

import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../../domain/artifactGraph.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { scanCanonicalArtifactInventory } from "./scanCanonical.js";
import type {
  ArtifactIntegrityPolicy,
  ArtifactInventoryOptions,
  ArtifactInventorySnapshot,
} from "./types.js";

export { scanCanonicalArtifactInventory } from "./scanCanonical.js";

export type {
  ArtifactIntegrityPolicy,
  ArtifactInventoryOptions,
  ArtifactInventorySnapshot,
} from "./types.js";

/** Inventory one local artifact and return every graph collection inline. */
export const inventoryArtifact = async (
  inputPath: string,
  options: {
    readonly signal?: AbortSignal;
    readonly integrity?: ArtifactIntegrityPolicy;
  } = {},
): Promise<ArtifactInventoryResult> => {
  const snapshot = await scanArtifactInventory(inputPath, options);
  return artifactInventoryResultSchema.parse(snapshot);
};

/** Scan an artifact once and retain the complete immutable graph for projection. */
export const scanArtifactInventory = async (
  inputPath: string,
  options: ArtifactInventoryOptions = {},
): Promise<ArtifactInventorySnapshot> => {
  abortIfNeeded(options.signal);
  const path = await realpath(inputPath);
  return scanCanonicalArtifactInventory(path, options);
};
