import {
  fileSnapshotPartialObservationSchema,
  type FileSnapshotPartialObservation,
} from "../domain/fileSnapshotObservation.js";
import {
  type StableArtifactSnapshot,
  completedStableArtifactIdentity,
} from "./readStableArtifact.js";

/**
 * Completed file identity survives finalization and later decoding failures;
 * `completed` is the snapshot a provider already holds when its parser fails.
 */
export const completedStableArtifactObservation = (
  cause: unknown,
  path: string,
  completedSnapshot?: StableArtifactSnapshot,
): FileSnapshotPartialObservation | undefined => {
  const identity =
    completedSnapshot === undefined
      ? completedStableArtifactIdentity(cause)
      : {
          sha256: completedSnapshot.sha256,
          bytes: completedSnapshot.bytes.length,
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
