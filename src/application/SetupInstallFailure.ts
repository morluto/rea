export type SetupFailureCode =
  | "unsupported_host"
  | "download_failed"
  | "integrity_mismatch"
  | "authorization_or_package_manager_failed"
  | "launcher_missing"
  | "runtime_dependency_unavailable"
  | "unsupported_hopper_build"
  | "setup_cancelled"
  | "destination_exists"
  | "mount_failed"
  | "bundle_invalid"
  | "copy_failed";

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
    case "destination_exists":
      return {
        status: "failed",
        code: "destination_exists",
        remediation:
          "The Hopper installation destination already exists and was not replaced. Reuse the existing installation or move it aside, then rerun rea setup.",
      };
    case "mount":
      return {
        status: "failed",
        code: "mount_failed",
        remediation:
          "The verified Hopper disk image could not be mounted. Eject any stale Hopper image, check local disk access, then rerun rea setup.",
      };
    case "bundle":
      return {
        status: "failed",
        code: "bundle_invalid",
        remediation:
          "The mounted package did not contain the expected Hopper application bundle. Retry setup; if it repeats, update REA before installing.",
      };
    case "copy":
      return {
        status: "failed",
        code: "copy_failed",
        remediation:
          "The verified Hopper application could not be copied to the installation destination. Check destination permissions and free space, then rerun rea setup.",
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
