import type { ArtifactIntegrityCheck } from "../../domain/artifactOperationError.js";
import {
  ArtifactReaderFailure,
  malformedArtifact,
  truncatedArtifact,
} from "../../resources/index.js";

const FORMAT = "pyinstaller";

/** Typed failure from a pure PyInstaller parser before the reader adapts it. */
export type PyInstallerFailure =
  | {
      readonly reason: "malformed" | "truncated" | "limit";
      readonly message: string;
    }
  | {
      readonly reason: "integrity";
      readonly message: string;
      readonly integrityCheck: ArtifactIntegrityCheck;
    };

/** Adapt a parser failure, keeping the integrity check it names. */
export const pyInstallerReaderFailure = (
  error: PyInstallerFailure,
): ArtifactReaderFailure => {
  switch (error.reason) {
    case "integrity":
      return new ArtifactReaderFailure(error.reason, error.message, {
        integrityCheck: error.integrityCheck,
      });
    case "malformed":
      return malformedArtifact(FORMAT, error.message);
    case "truncated":
      return truncatedArtifact(FORMAT, error.message);
    case "limit":
      return new ArtifactReaderFailure(error.reason, error.message);
  }
};

export const pyInstallerFailure = (
  reason: "malformed" | "truncated" | "limit",
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
