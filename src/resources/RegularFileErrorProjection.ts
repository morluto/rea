import { BinaryTargetError } from "../domain/configurationErrors.js";
import { RejectedRegularFileSymlink } from "../filesystem/RegularFile.js";
import { regularFileSymlinkRecovery } from "./StableArtifactFailure.js";

/** Project a selected-file admission failure without reinterpreting its path. */
export const selectedFileTargetError = (
  path: string,
  primary: Error,
  cause: unknown,
): BinaryTargetError =>
  new BinaryTargetError(path, primary.message, {
    cause,
    ...(primary instanceof RejectedRegularFileSymlink &&
    primary.resolvedPath !== undefined
      ? { remediationAction: regularFileSymlinkRecovery(primary.resolvedPath) }
      : {}),
  });
