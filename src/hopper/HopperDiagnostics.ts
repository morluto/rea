import type { ProcessCleanupResult } from "../process/ProcessOwnership.js";
import type { ProviderProcessStopResult } from "../process/ProviderProcess.js";
import type { BridgeLaunch } from "./BridgeLauncher.js";

/** Sanitized Hopper launcher and owned-shutdown telemetry. */
export type HopperDiagnostic =
  | { readonly type: "launcher-stderr"; readonly bytes: number }
  | { readonly type: "launcher-exit"; readonly code: number | null }
  | {
      readonly type: "owned-shutdown";
      readonly status: ProviderProcessStopResult["status"];
      readonly launcher_pid: number | null;
      readonly process_group_id: number | null;
      readonly cleanup_signaled: boolean | null;
      readonly reason: string | null;
    };

/** Retain actionable ownership coordinates without exposing the run token. */
export const createOwnedHopperShutdownDiagnostic = (
  launch: BridgeLaunch,
  stopped: ProviderProcessStopResult,
  cleanup: ProcessCleanupResult | undefined,
): Extract<HopperDiagnostic, { readonly type: "owned-shutdown" }> => ({
  type: "owned-shutdown",
  status: stopped.status,
  launcher_pid: launch.ownership?.leaderPid ?? launch.process.pid ?? null,
  process_group_id: launch.ownership?.processGroupId ?? null,
  cleanup_signaled: cleanup?.cleaned === true ? cleanup.signaled : null,
  reason: stopped.status === "incomplete" ? stopped.reason : null,
});

/** Convert an unexpected cleanup rejection without exposing a stack or token. */
export const providerCleanupFailure = (
  _cause: unknown,
): ProcessCleanupResult => ({
  cleaned: false,
  reason: "owned provider cleanup failed",
});
