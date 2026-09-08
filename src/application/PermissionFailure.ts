import {
  AnalysisProtocolError,
  PermissionRequiredError,
} from "../domain/errors.js";
import type { PermissionPathError } from "./PermissionAuthority.js";

/** Preserve permission denials and project failed path resolution for callers. */
export const projectPermissionFailure = (
  error: PermissionRequiredError | PermissionPathError,
): PermissionRequiredError | AnalysisProtocolError =>
  error instanceof PermissionRequiredError
    ? error
    : new AnalysisProtocolError(error.message, { cause: error });
