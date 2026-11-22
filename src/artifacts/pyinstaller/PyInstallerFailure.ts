import type { ArtifactIntegrityCheck } from "../../domain/artifactOperationError.js";
import { ArtifactReaderFailure } from "../../resources/index.js";

/** Typed failure from a pure PyInstaller parser before the reader adapts it. */
export type PyInstallerFailure =
  | { readonly reason: "format" | "limit"; readonly message: string }
  | {
      readonly reason: "integrity";
      readonly message: string;
      readonly integrityCheck: ArtifactIntegrityCheck;
    };

/** Adapt a parser failure, keeping the integrity check it names. */
export const pyInstallerReaderFailure = (
  error: PyInstallerFailure,
): ArtifactReaderFailure =>
  error.reason === "integrity"
    ? new ArtifactReaderFailure(error.reason, error.message, {
        integrityCheck: error.integrityCheck,
      })
    : new ArtifactReaderFailure(error.reason, error.message);

export const pyInstallerFailure = (
  reason: "format" | "limit",
  message: string,
): PyInstallerFailure => ({ reason, message });

/** Table entries that disagree with each other or place a member outside its archive. */
export const pyInstallerLayoutFailure = (
  message: string,
): PyInstallerFailure => ({
  reason: "integrity",
  message,
  integrityCheck: "layout-consistency",
});
