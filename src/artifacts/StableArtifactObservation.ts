import {
  fileSnapshotPartialObservationSchema,
  type FileSnapshotPartialObservation,
} from "../domain/fileSnapshotObservation.js";
import { completedStableArtifactIdentity } from "./readStableArtifact.js";

/** Completed file identity survives finalization; it does not establish decoded content. */
export const completedStableArtifactObservation = (
  cause: unknown,
  path: string,
): FileSnapshotPartialObservation | undefined => {
  const identity = completedStableArtifactIdentity(cause);
  return identity === undefined
    ? undefined
    : fileSnapshotPartialObservationSchema.parse({
        kind: "file-snapshot-hash",
        path,
        sha256: identity.sha256,
        bytes: identity.bytes,
      });
};
