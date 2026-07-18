import { realpath } from "node:fs/promises";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../domain/artifactGraph.js";
import { pageOf } from "./ArtifactGraphConstruction.js";
import { abortIfNeeded } from "./ArtifactInventory/hash.js";
import { scanCanonicalArtifactInventory } from "./ArtifactInventory/scanCanonical.js";
import type {
  ArtifactIntegrityPolicy,
  ArtifactInventoryOptions,
  ArtifactInventorySnapshot,
  ArtifactNativeMountPolicy,
  InventoryPageInput,
} from "./ArtifactInventory/types.js";

export { scanCanonicalArtifactInventory } from "./ArtifactInventory/scanCanonical.js";

export type {
  ArtifactIntegrityPolicy,
  ArtifactInventoryOptions,
  ArtifactInventorySnapshot,
  ArtifactNativeMountPolicy,
  InventoryPageInput,
} from "./ArtifactInventory/types.js";

/** Inventory one local artifact without extracting or mounting it. */
export const inventoryArtifact = async (
  inputPath: string,
  limits: ArtifactLimits,
  page: InventoryPageInput,
  options: {
    readonly signal?: AbortSignal;
    readonly nativeMount?: ArtifactNativeMountPolicy;
    readonly integrity?: ArtifactIntegrityPolicy;
  } = {},
): Promise<ArtifactInventoryResult> => {
  const snapshot = await scanArtifactInventory(inputPath, limits, options);
  return paginateArtifactInventory(snapshot, page);
};

/** Scan an artifact once and retain the complete immutable graph for projection. */
export const scanArtifactInventory = async (
  inputPath: string,
  limits: ArtifactLimits,
  options: ArtifactInventoryOptions = {},
): Promise<ArtifactInventorySnapshot> => {
  abortIfNeeded(options.signal);
  const path = await realpath(inputPath);
  return scanCanonicalArtifactInventory(path, limits, options);
};

/** Project independently paged graph collections from one inventory snapshot. */
export const paginateArtifactInventory = (
  snapshot: ArtifactInventorySnapshot,
  page: InventoryPageInput,
): ArtifactInventoryResult =>
  artifactInventoryResultSchema.parse({
    ...snapshot,
    nodes: pageOf(snapshot.nodes, page.nodeOffset, page.nodeLimit),
    occurrences: pageOf(
      snapshot.occurrences,
      page.occurrenceOffset,
      page.occurrenceLimit,
    ),
    edges: pageOf(snapshot.edges, page.edgeOffset, page.edgeLimit),
  });
