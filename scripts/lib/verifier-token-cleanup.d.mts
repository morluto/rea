import type {
  ProcessCleanupResult,
  ProcessOwnershipHost,
} from "../../src/process/ProcessOwnership.js";
import type { VerifierRunStart } from "./verifier-run.mjs";

/** Capture the prelaunch identities used by the canonical, PPID-independent sweep. */
export function prepareVerifierTokenCleanup(
  run: VerifierRunStart,
  suppliedHost?: ProcessOwnershipHost,
): Promise<{
  /** Register a validated provider run ID before any operation can start it. */
  registerProviderRun(runId: string): void;
  /** Retain verified live ownership for a registered provider run. */
  retainProviderRun(
    runId: string,
    providerScope?: {
      readonly leaderPid: number;
      readonly processGroupId: number;
      readonly sampledProcessGroupIds?: readonly number[];
    },
  ): Promise<void>;
  verify(): Promise<{
    readonly cleaned: boolean;
    readonly reason?: string;
    readonly runs: readonly {
      readonly run_id: string;
      readonly result: ProcessCleanupResult;
    }[];
  }>;
  close(): Promise<void>;
}>;
