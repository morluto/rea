import {
  fileSnapshotPartialObservationSchema,
  type FileSnapshotPartialObservation,
} from "../domain/fileSnapshotObservation.js";
import {
  type StableArtifactSnapshot,
  completedStableArtifact,
} from "./readStableArtifact.js";

/** Completed file identity survives finalization; it does not establish decoded content. */
export const completedStableArtifactObservation = (
  cause: unknown,
  path: string,
  completedSnapshot?: StableArtifactSnapshot,
): FileSnapshotPartialObservation | undefined => {
  const snapshot = completedSnapshot ?? completedStableArtifact(cause);
  return snapshot === undefined
    ? undefined
    : fileSnapshotPartialObservationSchema.parse({
        kind: "file-snapshot-hash",
        path,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes.length,
      });
};
