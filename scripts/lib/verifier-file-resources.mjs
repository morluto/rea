import { hashStableFile } from "../../dist/filesystem/StableFileHash.js";
import { ArtifactResourceScope } from "../../dist/resources/ArtifactResourceScope.js";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";

/** Finish a prerequisite probe and release its exact retained cleanup owners. */
export async function withVerifierResourceOwner(operation) {
  const resources = new ArtifactResourceScope();
  return withVerifierCleanup(
    () => operation(resources.forCloseOwners()),
    [() => resources.close()],
  );
}

/** Hash one verifier input while retaining any descriptor whose close fails. */
export function hashVerifierFile(path, resources) {
  return hashStableFile(path, {
    retainFailedClose(owner) {
      resources.retain({ kind: "file-handle", resource: path, handle: owner });
    },
  });
}
