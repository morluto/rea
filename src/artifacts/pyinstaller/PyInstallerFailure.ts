import type { ArtifactIntegrityCheck } from "../../domain/artifactOperationError.js";

/** Typed failure from a pure PyInstaller parser before the reader adapts it. */
export type PyInstallerFailure =
  | { readonly reason: "format" | "limit"; readonly message: string }
  | {
      readonly reason: "integrity";
      readonly message: string;
      readonly integrityCheck: ArtifactIntegrityCheck;
    };

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
