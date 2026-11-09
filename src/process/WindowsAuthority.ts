import {
  systemWindowsNativeAuthority,
  windowsNativeFailureRemediation,
  type WindowsNativeLoadResult,
} from "../windows/WindowsNativeLoader.js";

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
      readonly retryable?: true;
      readonly code:
        | "unsupported_host"
        | "runtime_missing"
        | "runtime_unavailable";
      readonly failureStage: Exclude<
        WindowsNativeLoadResult,
        { available: true }
      >["failureStage"];
      readonly remediation: string;
    };

/** Security controls required before REA may claim Windows isolation. */
export interface WindowsNativeCapabilitySet {
  readonly job_object_process_ownership: WindowsNativeCapability;
  readonly private_runtime_dacl: WindowsNativeCapability;
  readonly reparse_safe_path_admission: WindowsNativeCapability;
}

/** One readiness observation, shared by diagnostics and security controls. */
export type WindowsNativeReadiness =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: string;
      readonly failureStage: Exclude<
        WindowsNativeLoadResult,
        { available: true }
      >["failureStage"];
      readonly code:
        | "unsupported_host"
        | "runtime_missing"
        | "runtime_unavailable";
      readonly retryable?: true;
      readonly remediation: string;
      readonly proof: "not-proven" | "not-applicable";
    };

/** Interpret the loader's tagged failure without guessing from OS error text. */
export const inspectWindowsNativeReadiness = (
  platform: NodeJS.Platform,
  observation?: WindowsNativeLoadResult,
): WindowsNativeReadiness => {
  if (platform !== "win32")
    return {
      available: false,
      failureStage: "host",
      reason: "Windows native authority is not applicable on this host",
      proof: "not-applicable",
      code: "unsupported_host",
      remediation: "Use a Windows x64 host for Windows native controls.",
    };
  const loaded = observation ?? systemWindowsNativeAuthority();
  if (loaded.available) return { available: true };
  const failureStage = loaded.failureStage;
  return {
    available: false,
    failureStage,
    reason: loaded.reason,
    ...(loaded.retryable === true ? { retryable: true as const } : {}),
    proof: "not-proven",
    code:
      failureStage === "host"
        ? "unsupported_host"
        : failureStage === "artifact" || failureStage === "load"
          ? "runtime_missing"
          : "runtime_unavailable",
    remediation: windowsNativeFailureRemediation(failureStage),
  };
};

/**
 * Describe native Windows controls without inferring them from taskkill,
 * chmod, symlink creation, or a numeric POSIX open flag.
 */
export const windowsNativeCapabilities = (
  platform: NodeJS.Platform,
  readiness: WindowsNativeReadiness = inspectWindowsNativeReadiness(platform),
): WindowsNativeCapabilitySet => {
  const capability = readiness.available
    ? ({ available: true, reason: null, proof: "native-authority" } as const)
    : ({
        available: false,
        reason: readiness.reason,
        proof: readiness.proof,
        code: readiness.code,
        failureStage: readiness.failureStage,
        remediation: readiness.remediation,
        ...(readiness.retryable === true ? { retryable: true as const } : {}),
      } as const);
  return {
    job_object_process_ownership: capability,
    private_runtime_dacl: capability,
    reparse_safe_path_admission: capability,
  };
};
