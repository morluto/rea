import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { hashStableRootArtifact } from "./StableRootArtifact.js";

/**
 * The `container-identity` failure for a selected target whose observed
 * digest no longer matches the one the session admitted.
 */
export const targetDigestChangedFailure = (
  subject: string,
  expected: string,
  observed: string,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "integrity",
    `Active ${subject} digest changed: expected ${expected}, observed ${observed}`,
    { integrityCheck: "container-identity" },
  );

/** Bind live resource reads to the target identity established by the session. */
export const withArtifactTargetIdentity = async <T>(
  target: BinaryTarget,
  resources: ArtifactResourceScope,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const verify = async () => {
    const digest = await hashStableRootArtifact(target.path, resources, signal);
    if (digest.sha256 !== target.sha256)
      throw targetDigestChangedFailure("target", target.sha256, digest.sha256);
  };
  await verify();
  const result = await read();
  await verify();
  return result;
};
