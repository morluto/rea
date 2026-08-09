import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type {
  ArtifactIntegrityPolicy,
  ArtifactNativeMountPolicy,
} from "./types.js";

/** Parsed caller intent for integrity mismatch handling. */
export type ArtifactIntegrityIntent =
  | { readonly mode: "fail" }
  | {
      readonly mode: "record-and-continue";
      readonly maxMismatches: number;
    };

/** Resolve caller approval and operator policy before native reader selection. */
export const resolveNativeMountPolicy = (
  approved: boolean,
  enabled: boolean,
): ArtifactNativeMountPolicy => {
  if (!approved) return { status: "disabled" };
  if (!enabled)
    throw new ArtifactReaderFailure(
      "unavailable",
      "Native DMG mounting is disabled by operator policy",
    );
  return { status: "approved" };
};

/** Resolve parsed caller intent and operator policy before artifact scanning. */
export const resolveArtifactIntegrityPolicy = (
  intent: ArtifactIntegrityIntent,
  enabled: boolean,
): ArtifactIntegrityPolicy => {
  if (intent.mode === "fail") return intent;
  if (!enabled)
    throw new ArtifactReaderFailure(
      "policy",
      "Integrity continuation requires explicit approval and operator policy",
    );
  return intent;
};
