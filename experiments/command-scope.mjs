import { randomUUID } from "node:crypto";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../dist/process/OwnedCommand.js";
import { prepareProcessOwnershipInspection } from "../dist/process/ProcessOwnershipObservation.js";

/** Settle every retained command before dependent resources can be reconciled. */
export async function settleCommandOwners(owners) {
  const failures = [];
  for (const owner of owners) {
    try {
      const stopped = await owner.stop();
      if (stopped.status === "incomplete" || stopped.status === "not-owned") {
        const error = new Error(
          `Experiment cleanup remains ${stopped.status}: ${stopped.reason ?? "process ownership was not established"}`,
          { cause: stopped },
        );
        error.stopResult = stopped;
        failures.push(error);
      } else owners.delete(owner);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) {
    const error = new AggregateError(
      failures,
      "Experiment command cleanup failed",
    );
    error.cleanupOwners = owners;
    throw error;
  }
}

/** Bounded command ownership for manual, unshipped experiments. */
export async function withCommands(work) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Experiment cancelled"));
  const owners = new Set();
  const settle = () => settleCommandOwners(owners);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const run = async (command, args, options = {}) => {
    try {
      await prepareProcessOwnershipInspection(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted)
        throw new OwnedCommandFailure(
          "cancelled",
          "Experiment cancelled during ownership preparation",
          null,
          null,
          { cause },
        );
      throw cause;
    }
    const result = await runOwnedCommand(
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
  let value;
  let failed = false;
  let primary;
  try {
    value = await work(run, controller.signal, settle);
  } catch (cause) {
    failed = true;
    primary = cause;
  }
  const failures = [];
  try {
    await settle();
  } catch (cause) {
    failures.push(cause);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  if (failures.length) {
    const error = new AggregateError(
      [...(failed ? [primary] : []), ...failures],
      "Experiment cleanup failed",
      { cause: primary },
    );
    error.cleanupOwners = owners;
    throw error;
  }
  if (failed) throw primary;
  if (controller.signal.aborted)
    throw new OwnedCommandFailure("cancelled", "Experiment cancelled");
  return value;
}
