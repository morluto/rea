/**
 * Provider-neutral security controls that require a verified Windows native
 * authority. Runtime probes and POSIX permissions do not satisfy these
 * controls.
 */
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
  "Verified Windows native authority is unavailable: Job Object process ownership, private runtime DACL enforcement, and reparse-safe path admission are not implemented; chmod(0700) is insufficient for Windows private DACL proof, and taskkill is not a Job Object security proof";

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
