import { classifyLaunchFailure, type LaunchRefusal } from "./launchFailure.js";
import { OwnedCommandFailure } from "./OwnedCommand.js";
import type { ProviderProcessSnapshot } from "./ProviderProcess.js";

/** Output the supervisor retained for one outcome. */
export interface ProviderOutcomeOutput {
  readonly snapshot: ProviderProcessSnapshot;
  /**
   * True when the retained output omits bytes: the retention budget was
   * exceeded or a provider stream was destroyed before it drained.
   */
  readonly truncated: boolean;
}

interface ProviderOutcomeFacts {
  /** The value the supervisor or launcher threw; kept as the error cause. */
  readonly cause: unknown;
  readonly message: string;
  /** Absent when the failure happened before any process output existed. */
  readonly output: ProviderOutcomeOutput | undefined;
}

/**
 * What physically happened to one owned provider command, read once from the
 * supervisor's facts. Classification into a typed error belongs to
 * `classifyProviderOutcome`.
 */
export type ProviderOutcome =
  /** The operating system refused to start the selected executable. */
  | (ProviderOutcomeFacts & {
      readonly kind: "launch-refused";
      readonly refusal: LaunchRefusal;
    })
  /** The caller cancelled; `reason` is the caller's opaque abort reason. */
  | (ProviderOutcomeFacts & {
      readonly kind: "cancelled";
      readonly reason: unknown;
    })
  /** The owner's deadline elapsed. */
  | (ProviderOutcomeFacts & { readonly kind: "timeout" })
  /** Output exceeded the owner's complete-output budget. */
  | (ProviderOutcomeFacts & { readonly kind: "output-limit" })
  /** The process tree reached its enforced memory limit. */
  | (ProviderOutcomeFacts & { readonly kind: "memory-limit" })
  /** The process ended on an inherited CPU-time or file-size limit signal. */
  | (ProviderOutcomeFacts & {
      readonly kind: "resource-signal";
      readonly signal: "SIGXCPU" | "SIGXFSZ";
    })
  /**
   * The process ended with this status. `stopRequested` is true when the
   * owner had begun stopping it, so a signal may be the owner's.
   */
  | (ProviderOutcomeFacts & {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stopRequested: boolean;
    })
  /** Collecting the command's streams failed, or no process facts exist. */
  | (ProviderOutcomeFacts & { readonly kind: "protocol" });

const outputOf = (
  snapshot: ProviderProcessSnapshot | null,
): ProviderOutcomeOutput | undefined =>
  snapshot === null
    ? undefined
    : {
        snapshot,
        truncated:
          snapshot.diagnosticTruncated === true ||
          snapshot.outputIncomplete === true,
      };

const ownedCommandOutcome = (failure: OwnedCommandFailure): ProviderOutcome => {
  const facts = {
    cause: failure,
    message: failure.message,
    output: outputOf(failure.snapshot),
  };
  if (failure.reason === "cancelled")
    return {
      ...facts,
      kind: "cancelled",
      reason:
        failure.cancellation === undefined
          ? failure
          : failure.cancellation.reason,
    };
  // An allocation refused by the enforced limit can surface as a hang, an
  // overflow or an exit; the limit is the fact that explains each of them.
  if (failure.snapshot?.memoryLimitReached === true)
    return { ...facts, kind: "memory-limit" };
  if (failure.reason !== "process") return { ...facts, kind: failure.reason };
  const snapshot = failure.snapshot;
  if (failure.collectionFailure || snapshot === null)
    return { ...facts, kind: "protocol" };
  if (snapshot.signal === "SIGXCPU" || snapshot.signal === "SIGXFSZ")
    return { ...facts, kind: "resource-signal", signal: snapshot.signal };
  return {
    ...facts,
    kind: "exited",
    exitCode: snapshot.exitCode ?? null,
    signal: snapshot.signal ?? null,
    stopRequested: snapshot.stopRequested === true,
  };
};

/**
 * Read the outcome of an owned command from what `runOwnedCommand` threw.
 * Undefined when the value is neither a supervised command failure nor a
 * launch refusal.
 */
export function providerOutcomeOf(cause: OwnedCommandFailure): ProviderOutcome;
export function providerOutcomeOf(cause: unknown): ProviderOutcome | undefined;
export function providerOutcomeOf(cause: unknown): ProviderOutcome | undefined {
  if (cause instanceof OwnedCommandFailure) return ownedCommandOutcome(cause);
  const refusal = classifyLaunchFailure(cause);
  if (refusal === undefined || !(cause instanceof Error)) return undefined;
  return {
    kind: "launch-refused",
    refusal,
    cause,
    message: cause.message,
    output: undefined,
  };
}
