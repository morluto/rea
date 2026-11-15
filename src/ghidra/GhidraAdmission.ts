import {
  inspectWindowsNativeReadiness,
  type WindowsNativeReadiness,
} from "../process/WindowsAuthority.js";
import type {
  AvailableGhidraInstallation,
  GhidraInstallationInspection,
  UnavailableGhidraInstallation,
} from "./GhidraInstallation.js";

/** Why Ghidra's local prerequisites refuse an inspected installation. */
export type GhidraAdmissionRefusal =
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
 * and the provider's readiness both project, so they cannot disagree. The
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
): GhidraAdmission => {
  const windowsNative =
    installation.platform === "win32"
      ? inspectWindowsNativeReadiness(installation.platform)
      : undefined;
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
