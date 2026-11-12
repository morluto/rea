import type { ProcessIdentityObservation } from "./ProcessOwnership.js";
import {
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../filesystem/OwnedRegularFile.js";
import { RegularFileOperationCancelled } from "../filesystem/RegularFile.js";
import { FileReadCancelled } from "../filesystem/readFileHandleChunks.js";
import { ExecFileOutputCancelledError } from "./ExecFileOutput.js";

/** Cancellation observed by ownership inspection, separate from opaque caller values. */
export class ProcessOwnershipInspectionCancelled extends Error {
  readonly _tag = "ProcessOwnershipInspectionCancelled";

  constructor(
    readonly reason: unknown,
    options?: { readonly cause: unknown },
  ) {
    super("Process ownership inspection cancelled", {
      cause: options === undefined ? reason : options.cause,
    });
    this.name = this._tag;
  }

  /** Normalize only cancellation facts emitted by the actual lower-level owner. */
  static from(
    cause: unknown,
  ):
    | ProcessOwnershipInspectionCancelled
    | ProcessOwnershipIdentityBatchFailure
    | undefined {
    if (isProcessOwnershipInspectionCancellation(cause)) return cause;
    if (cause instanceof ExecFileOutputCancelledError)
      return new ProcessOwnershipInspectionCancelled(cause.cause, { cause });
    if (
      cause instanceof RegularFileOperationCancelled ||
      cause instanceof RegularFileCancelled ||
      cause instanceof FileReadCancelled
    )
      return new ProcessOwnershipInspectionCancelled(cause.reason, { cause });
    return undefined;
  }
}

export const assertProcessOwnershipInspectionActive = (
  signal?: AbortSignal,
): void => {
  if (signal?.aborted === true)
    throw new ProcessOwnershipInspectionCancelled(signal.reason);
};

/** Neither signal state, error identity nor error names establish cancellation origin. */
export const isProcessOwnershipInspectionCancellation = (
  cause: unknown,
): cause is
  | ProcessOwnershipInspectionCancelled
  | ProcessOwnershipIdentityBatchFailure =>
  cause instanceof ProcessOwnershipInspectionCancelled ||
  (cause instanceof ProcessOwnershipIdentityBatchFailure &&
    cause.origin === "cancelled");

/** One native identity batch has settled every admitted read, retaining failed owners and completed facts. */
export class ProcessOwnershipIdentityBatchFailure extends AggregateError {
  readonly _tag = "ProcessOwnershipIdentityBatchFailure";
  readonly cancellations: readonly {
    readonly pid: number;
    readonly requestIndex: number;
    readonly cancellation:
      | ProcessOwnershipInspectionCancelled
      | ProcessOwnershipIdentityBatchFailure;
  }[];
  readonly physicalFailures: readonly {
    readonly pid: number;
    readonly requestIndex: number;
    readonly cause: unknown;
  }[];
  readonly origin: "cancelled" | "physical";

  /** Single caller cancellation value; every request's explicit fact remains in cancellations. */
  get reason(): unknown {
    return this.cancellations[0]?.cancellation.reason;
  }

  constructor(
    readonly failures: readonly {
      readonly pid: number;
      readonly requestIndex: number;
      readonly cause: unknown;
    }[],
    readonly observations: ReadonlyMap<number, ProcessIdentityObservation>,
    physicalReadFailures: readonly {
      readonly pid: number;
      readonly requestIndex: number;
      readonly cause: unknown;
    }[] = [],
  ) {
    super(
      [...physicalReadFailures, ...failures].map(({ cause }) => cause),
      "Native process identity inspection failed",
    );
    this.name = this._tag;
    const cancellations: Array<{
      pid: number;
      requestIndex: number;
      cancellation:
        | ProcessOwnershipInspectionCancelled
        | ProcessOwnershipIdentityBatchFailure;
    }> = [];
    const physicalFailures = [...physicalReadFailures];
    for (const { pid, requestIndex, cause } of failures) {
      const cancellation =
        cause instanceof RegularFileCleanupFailure
          ? cause.outcome.kind === "failed"
            ? ProcessOwnershipInspectionCancelled.from(cause.outcome.cause)
            : cause.completionCancellation === undefined
              ? undefined
              : new ProcessOwnershipInspectionCancelled(
                  cause.completionCancellation.reason,
                  { cause },
                )
          : ProcessOwnershipInspectionCancelled.from(cause);
      if (cancellation !== undefined)
        cancellations.push({ pid, requestIndex, cancellation });
      if (
        cause instanceof RegularFileCleanupFailure ||
        cancellation === undefined
      )
        physicalFailures.push({ pid, requestIndex, cause });
    }
    this.cancellations = cancellations;
    this.physicalFailures = physicalFailures;
    this.origin =
      physicalFailures.length === 0 && cancellations.length > 0
        ? "cancelled"
        : "physical";
  }
}

/** Unavailable observations must not discard cancellation or a retained descriptor owner. */
export const rethrowProcessOwnershipInspectionFailure = (
  cause: unknown,
): void => {
  if (
    cause instanceof RegularFileCleanupFailure ||
    cause instanceof ProcessOwnershipIdentityBatchFailure
  )
    throw cause;
  const cancellation = ProcessOwnershipInspectionCancelled.from(cause);
  if (cancellation !== undefined) throw cancellation;
};

/** Cancellable inspection backoff owns its abort outcome rather than parsing a timer error. */
export const waitForProcessOwnershipInspection = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  assertProcessOwnershipInspectionActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ProcessOwnershipInspectionCancelled(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
};
