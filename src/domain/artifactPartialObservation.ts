import type { ArtifactInventorySnapshot } from "./artifactInventorySnapshot.js";

/** A complete inventory retained when releasing its provider resources fails. */
export interface ArtifactInventoryPartialObservation {
  readonly kind: "artifact-inventory";
  readonly inventory: ArtifactInventorySnapshot;
}
