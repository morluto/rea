import { randomUUID } from "node:crypto";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../dist/process/OwnedCommand.js";
import { prepareProcessOwnershipInspection } from "../dist/process/ProcessOwnershipObservation.js";

/** Physical cleanup facts, without serializing a live process owner. */
export class ExperimentCommandCleanupFailure extends Error {
  constructor(result) {
    super(`Experiment cleanup remains ${result.status}`);
    this.name = "ExperimentCommandCleanupFailure";
    this.result = result;
  }
}

/** One interpreter and retry owner for the remaining retained commands. */
async function settleCommandOwners(owners) {
  const failures = [];
  for (const owner of owners) {
    try {
      const stopped = await owner.stop();
      if (stopped.status === "incomplete" || stopped.status === "not-owned")
        failures.push(new ExperimentCommandCleanupFailure(stopped));
      else owners.delete(owner);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) {
    const error = new AggregateError(failures, "Experiment cleanup failed");
    error.cleanupOwners = owners;
    error.retryCleanup = () => settleCommandOwners(owners);
    throw error;
  }
}

/** Bounded command ownership for manual, unshipped experiments. */
export async function withCommands(
  work,
  {
    // Controlled producer seams for lifecycle interleavings, not runtime modes.
    runCommand = runOwnedCommand,
    prepareOwnership = prepareProcessOwnershipInspection,
  } = {},
) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted)
      controller.abort(new Error("Experiment cancelled"));
  };
  const cancelled = () =>
    new OwnedCommandFailure("cancelled", "Experiment cancelled", null, null, {
      cause: controller.signal.reason,
      cancellation: { reason: controller.signal.reason },
    });
  const owners = new Set();
  const active = new Set();
  // Pending-work ownership and durable failed outcomes have different lifetimes.
  // Do not retain successful output, but keep every failed cause until scope
  // completion even when its command settled before the callback returned.
  const commandFailures = new Set();
  let accepting = true;
  // Keep both handlers until the final owned cleanup settles. A second signal
  // must not restore Node's default termination in the middle of that cleanup.
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const execute = async (command, args, options) => {
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      await prepareOwnership(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) throw cancelled();
      throw cause;
    }
    const result = await runCommand(
      {
        command,
        arguments: args,
        runId: randomUUID(),
        expectedCommand: null,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.environment === undefined
          ? {}
          : { hostEnvironment: options.environment }),
      },
      {
        timeoutMs: options.timeoutMs ?? 60_000,
        diagnosticBytes: options.maxBytes ?? 1024 * 1024,
        acceptNonZeroExit: options.acceptNonZeroExit ?? false,
      },
      {
        signal: controller.signal,
        retainCleanup: (owner) => owners.add(owner),
      },
    );
    return {
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      code: result.exitCode,
    };
  };
  const run = (command, args, options = {}) => {
    if (!accepting)
      return Promise.reject(
        new OwnedCommandFailure(
          "cancelled",
          "Experiment command scope is closed",
        ),
      );
    // Own admission before asynchronous preparation. A callback that returns
    // while a command is starting cannot leave a late command outside cleanup.
    const running = execute(command, args, options);
    const settled = running.then(
      () => {},
      (cause) => {
        commandFailures.add(cause);
      },
    );
    active.add(settled);
    void settled.then(() => active.delete(settled));
    return running;
  };
  try {
    let value;
    const failures = [];
    try {
      value = await work(run, controller.signal);
    } catch (cause) {
      failures.push(cause);
    }
    accepting = false;
    await Promise.all(active);
    for (const cause of commandFailures)
      if (!failures.includes(cause)) failures.push(cause);
    let cleanup;
    try {
      await settleCommandOwners(owners);
    } catch (cause) {
      cleanup = cause;
    }
    if (
      controller.signal.aborted &&
      !failures.some(
        (failure) =>
          failure instanceof OwnedCommandFailure &&
          failure.cancellation?.reason === controller.signal.reason,
      )
    )
      failures.push(cancelled());
    if (cleanup !== undefined) {
      const error = new AggregateError(
        [...failures, ...cleanup.errors],
        "Experiment cleanup failed",
        { cause: failures[0] },
      );
      error.cleanupOwners = owners;
      error.retryCleanup = cleanup.retryCleanup;
      throw error;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Experiment work failed", {
        cause: failures[0],
      });
    return value;
  } finally {
    accepting = false;
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
