import {
  fileSnapshotPartialObservationSchema,
  type FileSnapshotPartialObservation,
} from "../domain/fileSnapshotObservation.js";
import {
  type StableArtifactSnapshot,
  completedStableArtifact,
} from "./readStableArtifact.js";

/** Identity facts of one completed stable read; they do not establish decoded content. */
export const stableArtifactObservation = (
  snapshot: StableArtifactSnapshot,
  path: string,
): FileSnapshotPartialObservation =>
  fileSnapshotPartialObservationSchema.parse({
    kind: "file-snapshot-hash",
    path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes.length,
  });

/**
 * Completed file identity survives finalization and later decoding failures;
 * `completed` is the snapshot a provider already holds when its parser fails.
 */
export const completedStableArtifactObservation = (
  cause: unknown,
  path: string,
  completedSnapshot?: StableArtifactSnapshot,
): FileSnapshotPartialObservation | undefined => {
  const snapshot = completedSnapshot ?? completedStableArtifact(cause);
  return snapshot === undefined
    ? undefined
    : stableArtifactObservation(snapshot, path);
};
