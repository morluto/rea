export type SetupFailureCode =
  | "unsupported_host"
  | "download_failed"
  | "integrity_mismatch"
  | "authorization_or_package_manager_failed"
  | "launcher_missing"
  | "runtime_dependency_unavailable"
  | "unsupported_hopper_build"
  | "setup_cancelled";

export type SetupHopperInstallResult =
  | { readonly status: "installed"; readonly launcherPath: string }
  | {
      readonly status: "failed";
      readonly code: SetupFailureCode;
      readonly remediation: string;
    };

export type HopperInstallFailureReason =
  | "unsupported_host"
  | "release_metadata"
  | "download"
  | "integrity"
  | "authorization_or_package_manager"
  | "launcher_missing"
  | "runtime_dependencies"
  | "unsupported_hopper_build"
  | "cancelled"
  | "destination_exists"
  | "mount"
  | "bundle"
  | "copy";

/** Map provider installer failures to stable setup codes and safe recovery. */
export const setupInstallFailure = (
  reason: HopperInstallFailureReason,
): SetupHopperInstallResult => {
  switch (reason) {
    case "unsupported_host":
      return {
        status: "failed",
        code: "unsupported_host",
        remediation: "Use a supported host, then rerun rea setup.",
      };
    case "integrity":
      return {
        status: "failed",
        code: "integrity_mismatch",
        remediation:
          "The Hopper download failed integrity verification. Retry setup; if it repeats, update REA before installing.",
      };
    case "authorization_or_package_manager":
      return {
        status: "failed",
        code: "authorization_or_package_manager_failed",
        remediation:
          "Allow the system package-manager operation or install the planned Hopper package and Linux runtime dependencies, then rerun rea setup.",
      };
    case "launcher_missing":
      return {
        status: "failed",
        code: "launcher_missing",
        remediation:
          "The package operation completed but Hopper is not runnable. Run rea doctor and repair the reported launcher issue.",
      };
    case "runtime_dependencies":
      return {
        status: "failed",
        code: "runtime_dependency_unavailable",
        remediation:
          "Hopper was installed but required shared libraries are missing. Rerun rea setup, then apply the hopper-demo-runtime remediation from rea doctor.",
      };
    case "unsupported_hopper_build":
      return {
        status: "failed",
        code: "unsupported_hopper_build",
        remediation:
          "The installed Hopper launcher does not match the build supported by this REA release. Unset HOPPER_LAUNCHER_PATH, reinstall through rea setup, or update REA.",
      };
    case "cancelled":
      return {
        status: "failed",
        code: "setup_cancelled",
        remediation:
          "Setup was cancelled before Hopper was installed. Rerun rea setup when ready.",
      };
    default:
      return {
        status: "failed",
        code: "download_failed",
        remediation:
          "REA could not download or unpack the official Hopper package. Check network and filesystem access, then retry setup.",
      };
  }
};
