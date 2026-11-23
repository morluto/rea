import {
  fileSnapshotPartialObservationSchema,
  type FileSnapshotPartialObservation,
} from "../domain/fileSnapshotObservation.js";
import {
  type StableArtifactSnapshot,
  completedStableArtifactIdentity,
} from "./readStableArtifact.js";

/** Completed whole-file identity, with or without retained snapshot bytes. */
export type CompletedStableArtifact =
  | StableArtifactSnapshot
  | { readonly sha256: string; readonly bytes: number };

/**
 * Completed file identity survives finalization and later decoding failures;
 * `completed` is the snapshot or identity a provider already holds when its parser fails.
 */
export const completedStableArtifactObservation = (
  cause: unknown,
  path: string,
  completedSnapshot?: CompletedStableArtifact,
): FileSnapshotPartialObservation | undefined => {
  const identity =
    completedSnapshot === undefined
      ? completedStableArtifactIdentity(cause)
      : {
          sha256: completedSnapshot.sha256,
          bytes:
            typeof completedSnapshot.bytes === "number"
              ? completedSnapshot.bytes
              : completedSnapshot.bytes.length,
        };
  return identity === undefined
    ? undefined
    : fileSnapshotPartialObservationSchema.parse({
        kind: "file-snapshot-hash",
        path,
        sha256: identity.sha256,
        bytes: identity.bytes,
      });
};
