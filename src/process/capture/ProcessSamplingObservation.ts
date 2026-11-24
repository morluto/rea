import {
  isProcessInspectionFailure,
  processInspectionCancellations,
  type ProcessInspectionFailure,
} from "../ProcessInspectionCleanup.js";
import {
  ProcessOwnershipInspectionCancelled,
  isProcessOwnershipInspectionCancellation,
} from "../ProcessInspectionCancellation.js";
import { ProcessRunTokenReadError } from "../ProcessRunTokenObservations.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Settled sampling facts are neutral; each consumer owns its error presentation and cleanup. */
export class SamplingReadBatchFailure extends AggregateError {
  readonly #outcomes: readonly PromiseSettledResult<unknown>[];
  readonly #inspectionFailures: readonly ProcessInspectionFailure[];
  readonly #otherFailures: readonly unknown[];

  get outcomes(): readonly PromiseSettledResult<unknown>[] {
    return this.#outcomes;
  }

  get inspectionFailures(): readonly ProcessInspectionFailure[] {
    return this.#inspectionFailures;
  }

  get otherFailures(): readonly unknown[] {
    return this.#otherFailures;
  }

  constructor(outcomes: readonly PromiseSettledResult<unknown>[]) {
    const rejected = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : [],
    );
    super(rejected, "Admitted process sampling reads failed");
    this.name = "SamplingReadBatchFailure";
    this.#outcomes = outcomes;
    this.#inspectionFailures = [
      ...new Set(rejected.flatMap(samplingInspectionFailures)),
    ];
    this.#otherFailures = rejected.flatMap((failure) =>
      failure instanceof SamplingReadBatchFailure
        ? failure.otherFailures
        : isProcessInspectionFailure(failure)
          ? []
          : [failure],
    );
  }
}

/** Only the direct lower fact or this owner's explicit settled vector transfers inspection facts. */
export const samplingInspectionFailures = (
  cause: unknown,
): readonly ProcessInspectionFailure[] =>
  cause instanceof SamplingReadBatchFailure
    ? cause.inspectionFailures
    : isProcessInspectionFailure(cause)
      ? [cause]
      : [];

export function settleSamplingReads<T extends readonly Promise<unknown>[]>(
  reads: readonly [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;
export async function settleSamplingReads(
  reads: readonly Promise<unknown>[],
): Promise<unknown[]> {
  const outcomes = await Promise.allSettled(reads);
  if (outcomes.some((outcome) => outcome.status === "rejected"))
    throw new SamplingReadBatchFailure(outcomes);
  return outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value] : [],
  );
}

/** Retain a count, first failure and interruption fact with their observations. */
export interface SamplingDiagnostics {
  readonly count: number;
  readonly first: string | null;
  readonly interrupted: boolean;
}

export interface SamplingObservation<T> {
  readonly value: T;
  readonly diagnostics: SamplingDiagnostics;
}

export type SamplingReadFailure =
  | { readonly kind: "process-exited" }
  | { readonly kind: "cancelled"; readonly reason: unknown }
  | {
      readonly kind: "unavailable";
      readonly systemCode: string | undefined;
      readonly diagnostic: string;
    };

export const mergeSamplingDiagnostics = (
  ...parts: readonly SamplingDiagnostics[]
): SamplingDiagnostics => ({
  count: parts.reduce((count, part) => count + part.count, 0),
  first: parts.find((part) => part.first !== null)?.first ?? null,
  interrupted: parts.some((part) => part.interrupted),
});

export const samplingObservation = <T>(
  value: T,
  ...diagnostics: readonly SamplingDiagnostics[]
): SamplingObservation<T> => ({
  value,
  diagnostics: mergeSamplingDiagnostics(...diagnostics),
});

export const samplingFailure = (diagnostic: string): SamplingDiagnostics => ({
  count: 1,
  first: diagnostic,
  interrupted: false,
});

/** An interrupted attempt left an observation or declared traversal unfinished. */
export const samplingInterrupted = (): SamplingDiagnostics => ({
  count: 0,
  first: null,
  interrupted: true,
});

/** Settle each issued read, including peers still completing after shutdown. */
export const readSamplingSource = async <T>(
  source: string,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<Result<T, SamplingReadFailure>> => {
  if (signal.aborted) return err({ kind: "cancelled", reason: signal.reason });
  try {
    return ok(await read());
  } catch (cause: unknown) {
    const cancellation = ProcessOwnershipInspectionCancelled.from(cause);
    if (
      signal.aborted &&
      isProcessOwnershipInspectionCancellation(cancellation) &&
      processInspectionCancellations(cancellation).every(
        (fact) => fact.reason === signal.reason,
      )
    )
      return err({ kind: "cancelled", reason: signal.reason });
    const inspection = cancellation ?? cause;
    if (
      isProcessInspectionFailure(inspection) ||
      inspection instanceof SamplingReadBatchFailure
    )
      throw inspection;
    if (
      cause instanceof ProcessRunTokenReadError &&
      cause.availability === "absent"
    )
      return err({ kind: "process-exited" });
    const systemCode =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    const reason =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
    return err({
      kind: "unavailable",
      systemCode,
      diagnostic: `${source}: ${systemCode === undefined ? "" : `${systemCode}: `}${reason}`,
    });
  }
};

export const samplingReadObservation = <T>(
  result: Result<T, SamplingReadFailure>,
): SamplingObservation<T | undefined> =>
  result.ok
    ? samplingObservation(result.value)
    : samplingObservation(
        undefined,
        result.error.kind === "cancelled"
          ? samplingInterrupted()
          : result.error.kind === "process-exited"
            ? mergeSamplingDiagnostics()
            : samplingFailure(result.error.diagnostic),
      );

/** Missing procfs entries are expected exit races; denied reads stay unknown. */
export const readProcSamplingSource = async <T>(
  path: string,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<SamplingObservation<T | undefined>> => {
  const result = await readSamplingSource(path, signal, read);
  if (
    !result.ok &&
    result.error.kind === "unavailable" &&
    (result.error.systemCode === "ENOENT" ||
      result.error.systemCode === "ESRCH")
  )
    return samplingObservation(undefined);
  return samplingReadObservation(result);
};
