import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { hashStableRootArtifact } from "./StableRootArtifact.js";

/**
 * The session admitted a digest and will not replace it on a repeat of this
 * request. Reopening the target is what observes the current bytes; a
 * `changed` retry would fail the same comparison every time.
 */
export const targetDigestChangedFailure = (
  subject: string,
  expected: string,
  observed: string,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "integrity",
    `Active ${subject} digest changed: expected ${expected}, observed ${observed}`,
    {
      integrityCheck: "admitted-identity",
      userMessage:
        "The selected file no longer matches the digest this session admitted. Reopen the selected artifact, then retry.",
    },
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
