import {
  inspectWindowsNativeReadiness,
  type WindowsNativeReadiness,
} from "../process/WindowsAuthority.js";
import type {
  AvailableGhidraInstallation,
  GhidraInstallationInspection,
  UnavailableGhidraInstallation,
} from "./GhidraInstallation.js";

/** The selected database mode is not part of Windows P0 authority. */
export const EXISTING_PROJECT_WINDOWS_UNAVAILABLE =
  "An existing Ghidra project cannot be opened on the Windows launch path.";

/** Windows P0 imports targets into ephemeral projects only. */
export const EXISTING_PROJECT_WINDOWS_REMEDIATION =
  "Unset REA_GHIDRA_PROJECT_PATH in the environment that starts REA to import targets into an ephemeral project, or open the existing project on a supported Linux or macOS host; restart REA after changing the environment.";

/** Why Ghidra's local prerequisites refuse an inspected installation. */
export type GhidraAdmissionRefusal =
  | {
      /** REA_GHIDRA_PROJECT_PATH selects a project the Windows launch path cannot open. */
      readonly kind: "existing_project_unsupported_host";
      readonly installation: GhidraInstallationInspection;
    }
  | {
      readonly kind: "installation_rejected";
      readonly installation: UnavailableGhidraInstallation;
    }
  | {
      readonly kind: "windows_native_unavailable";
      readonly installation: AvailableGhidraInstallation;
      readonly readiness: Extract<
        WindowsNativeReadiness,
        { readonly available: false }
      >;
    };

/**
 * Ghidra's admission of an inspected installation: the one decision doctor
 * and the provider's readiness both project, so they cannot disagree. An
 * existing project (REA_GHIDRA_PROJECT_PATH) needs a POSIX host, the
 * installation must be usable, and a Windows installation also needs Windows
 * native authority. Nothing is created and Ghidra is not launched.
 */
export type GhidraAdmission = {
  /** Windows native authority, observed for a Windows installation only. */
  readonly windowsNative: WindowsNativeReadiness | undefined;
} & (
  | {
      readonly admitted: true;
      readonly installation: AvailableGhidraInstallation;
    }
  | { readonly admitted: false; readonly refusal: GhidraAdmissionRefusal }
);

export const admitGhidraInstallation = (
  installation: GhidraInstallationInspection,
  selection: {
    /** Whether REA_GHIDRA_PROJECT_PATH selects an existing project. */
    readonly existingProject: boolean;
  },
): GhidraAdmission => {
  const windowsNative =
    installation.platform === "win32"
      ? inspectWindowsNativeReadiness(installation.platform)
      : undefined;
  if (selection.existingProject && installation.platform === "win32")
    return {
      windowsNative,
      admitted: false,
      refusal: { kind: "existing_project_unsupported_host", installation },
    };
  if (installation.status !== "available")
    return {
      windowsNative,
      admitted: false,
      refusal: { kind: "installation_rejected", installation },
    };
  if (windowsNative?.available === false)
    return {
      windowsNative,
      admitted: false,
      refusal: {
        kind: "windows_native_unavailable",
        installation,
        readiness: windowsNative,
      },
    };
  return { windowsNative, admitted: true, installation };
};
