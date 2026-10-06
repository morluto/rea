import { systemWindowsNativeAuthority } from "../windows/WindowsNativeLoader.js";

/** Windows controls are proven by the packaged native boundary, not POSIX flags. */
export type WindowsNativeCapability =
  | {
      readonly available: true;
      readonly reason: null;
      readonly proof: "native-authority";
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly proof: "not-proven" | "not-applicable";
    };

/** Security controls required before REA may claim Windows isolation. */
export interface WindowsNativeCapabilitySet {
  readonly job_object_process_ownership: WindowsNativeCapability;
  readonly private_runtime_dacl: WindowsNativeCapability;
  readonly reparse_safe_path_admission: WindowsNativeCapability;
}

/** Stable explanation used whenever the native Windows authority is absent. */
export const WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON =
  "Windows native controls are unavailable in this runtime; use the Windows x64 REA package with its matching bundled native artifact.";

/**
 * Describe native Windows controls without inferring them from taskkill,
 * chmod, symlink creation, or a numeric POSIX open flag.
 */
export const windowsNativeCapabilities = (
  platform: NodeJS.Platform,
): WindowsNativeCapabilitySet => {
  if (platform !== "win32") {
    const notApplicable = {
      available: false,
      reason: "Windows native authority is not applicable on this host",
      proof: "not-applicable",
    } as const;
    return {
      job_object_process_ownership: notApplicable,
      private_runtime_dacl: notApplicable,
      reparse_safe_path_admission: notApplicable,
    };
  }

  if (process.platform === "win32") {
    const loaded = systemWindowsNativeAuthority();
    const capability = loaded.available
      ? ({ available: true, reason: null, proof: "native-authority" } as const)
      : ({
          available: false,
          reason: loaded.reason,
          proof: "not-proven",
        } as const);
    return {
      job_object_process_ownership: capability,
      private_runtime_dacl: capability,
      reparse_safe_path_admission: capability,
    };
  }

  const notProven = {
    available: false,
    reason: WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON,
    proof: "not-proven",
  } as const;
  return {
    job_object_process_ownership: notProven,
    private_runtime_dacl: notProven,
    reparse_safe_path_admission: notProven,
  };
};

/** Whether every native control needed for Windows isolation is proven. */
export const hasWindowsNativeAuthority = (platform: NodeJS.Platform): boolean =>
  Object.values(windowsNativeCapabilities(platform)).every(
    ({ available }) => available,
  );

/** Preserve the actual loader or operating-system constraint in provider errors. */
export const windowsNativeAuthorityUnavailableReason = (
  platform: NodeJS.Platform,
): string =>
  windowsNativeCapabilities(platform).job_object_process_ownership.reason ??
  WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON;
