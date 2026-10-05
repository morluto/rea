import type { ArtifactIntegrityPolicy } from "./types.js";

/** Parsed caller intent for integrity mismatch handling. */
export type ArtifactIntegrityIntent =
  | { readonly mode: "fail" }
  | { readonly mode: "record-and-continue" };

/** Preserve the explicit integrity admission choice without changing verification. */
export const resolveArtifactIntegrityPolicy = (
  intent: ArtifactIntegrityIntent,
): ArtifactIntegrityPolicy => intent;
