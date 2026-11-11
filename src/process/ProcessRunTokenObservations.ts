import type {
  ProcessOwnershipHost,
  ProcessRunTokenObservation,
  ProcessTableEntry,
} from "./ProcessOwnership.js";
import { liveProcesses } from "./ProcessOwnershipProcessTree.js";

/** Structured native token availability, distinct from failed reads and caller cancellation. */
export class ProcessRunTokenReadError extends Error {
  readonly _tag = "ProcessRunTokenReadError";
  constructor(
    readonly pid: number,
    readonly availability: "absent" | "unavailable",
    readonly reason: string,
  ) {
    super(`Run token for PID ${String(pid)}: ${reason}`);
    this.name = "ProcessRunTokenReadError";
  }
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Only a variable observed on this process supplies its run token. */
export const processRunIdFromEnvironment = (
  environment: Readonly<Record<string, string>>,
): string | undefined =>
  Object.hasOwn(environment, "REA_PROCESS_RUN_ID")
    ? environment.REA_PROCESS_RUN_ID
    : undefined;

/** Read a selected PID's environment token without requiring process-table relations. */
export const readProcessRunToken = async (
  host: ProcessOwnershipHost,
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessRunTokenObservation> => {
  signal?.throwIfAborted();
  try {
    const environment =
      signal === undefined
        ? await host.environment(pid)
        : await host.environment(pid, signal);
    signal?.throwIfAborted();
    return {
      state: "readable",
      runId: processRunIdFromEnvironment(environment),
    };
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    const code =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    return {
      state: "unavailable",
      ...(code === undefined ? {} : { code }),
      reason: errorMessage(cause),
    };
  }
};

/** Read only ownership tokens, using per-process fallback for missing batch rows. */
export async function* readProcessRunTokens(
  host: ProcessOwnershipHost,
  processes: readonly ProcessTableEntry[],
  signal?: AbortSignal,
): AsyncGenerator<{
  readonly process: ProcessTableEntry;
  readonly observation: ProcessRunTokenObservation;
}> {
  signal?.throwIfAborted();
  if (processes.length === 0) return;
  let batch: ReadonlyMap<number, ProcessRunTokenObservation> | undefined;
  let batchFailure: string | undefined;
  if (host.runTokens !== undefined) {
    try {
      batch =
        signal === undefined
          ? await host.runTokens(processes)
          : await host.runTokens(processes, signal);
    } catch (cause: unknown) {
      signal?.throwIfAborted();
      batchFailure = errorMessage(cause);
    }
  }
  for (const process of processes) {
    signal?.throwIfAborted();
    let observation = batch?.get(process.pid);
    if (observation === undefined) {
      observation = await readProcessRunToken(host, process.pid, signal);
      if (observation.state === "unavailable" && batchFailure !== undefined)
        observation = {
          ...observation,
          reason: `${observation.reason}; run-token batch failed: ${batchFailure}`,
        };
    }
    signal?.throwIfAborted();
    yield { process, observation };
  }
}

/**
 * Live processes in the current process table that expose this run token.
 * A process whose token cannot be read is left out, so the list proves
 * presence only; it does not prove that no other carrier exists.
 */
export const readRunTokenCarriers = async (
  host: ProcessOwnershipHost,
  runId: string,
  signal?: AbortSignal,
): Promise<readonly ProcessTableEntry[]> => {
  const carriers: ProcessTableEntry[] = [];
  const processes = liveProcesses(
    signal === undefined
      ? await host.listProcesses()
      : await host.listProcesses(signal),
  );
  for await (const { process, observation } of readProcessRunTokens(
    host,
    processes,
    signal,
  ))
    if (observation.state === "readable" && observation.runId === runId)
      carriers.push(process);
  return carriers;
};
