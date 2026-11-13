import type {
  ProcessCleanupResult,
  ProcessOwnershipHost,
} from "../../src/process/ProcessOwnership.js";
import type { VerifierRunStart } from "./verifier-run.mjs";
import type { RetainedProcessOwnershipCandidate } from "../../src/process/ProcessOwnershipEvidence.js";

interface VerifierTokenCleanupResult {
  readonly cleaned: boolean;
  readonly reason?: string;
  readonly runs: readonly {
    readonly run_id: string;
    readonly result: ProcessCleanupResult;
  }[];
}

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
  verify(): Promise<VerifierTokenCleanupResult>;
  /** Recover failed registered providers with canonical native ownership checks. */
  retryProviderCleanup(
    verification: VerifierTokenCleanupResult,
  ): Promise<VerifierTokenCleanupResult>;
  /** Transfer the pending provider cleanup and inspector to a retryable owner. */
  retainPendingProviderCleanup(verification: VerifierTokenCleanupResult): {
    close(): Promise<void>;
  };
  retainedProviderEvidence(): readonly {
    readonly run_id: string;
    readonly candidates: readonly (Pick<
      RetainedProcessOwnershipCandidate,
      "pid" | "identity" | "applicability" | "relation"
    > & {
      readonly scope_evidence: RetainedProcessOwnershipCandidate["scopeEvidence"];
    })[];
  }[];
  /** Retry a failed close on the same host and preserve any release failure. */
  close(): Promise<void>;
}>;
