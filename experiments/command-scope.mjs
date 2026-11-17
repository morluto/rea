import { randomUUID } from "node:crypto";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../dist/process/OwnedCommand.js";
import { prepareProcessOwnershipInspection } from "../dist/process/ProcessOwnershipObservation.js";
import { resolveWindowsProviderExecutable } from "../dist/process/WindowsProviderExecutable.js";
import { snapshotEnvironment } from "../dist/process/snapshotEnvironment.js";
import { retainOwnedCommandCleanup } from "../dist/providers/OwnedCommandCleanup.js";
import { HOST_PLATFORM } from "../dist/platform/HostPlatform.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
} from "../dist/process/WindowsBatchCommand.js";

/** Settle every retained command before dependent resources can be reconciled. */
export async function settleCommandOwners(
  owners,
  preparationOwners = new Set(),
) {
  const failures = [];
  for (const owner of owners) {
    try {
      if (preparationOwners.has(owner)) {
        await owner.close();
        owners.delete(owner);
        preparationOwners.delete(owner);
        continue;
      }
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
    error.retryCleanup = () => settleCommandOwners(owners, preparationOwners);
    throw error;
  }
}

/** Bounded command ownership for manual, unshipped experiments. */
export async function withCommands(
  work,
  {
    runCommand = runOwnedCommand,
    prepareOwnership = prepareProcessOwnershipInspection,
    platform = HOST_PLATFORM.platform,
    windowsExecutableLookup = {},
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
  const preparationOwners = new Set();
  const preparationScope = {
    retain: (owner) => {
      owners.add(owner);
      preparationOwners.add(owner);
    },
  };
  const settle = () => settleCommandOwners(owners, preparationOwners);
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const run = async (command, args, options = {}) => {
    const environment = snapshotEnvironment(
      options.environment ?? process.env,
      platform,
    );
    let selectedCommand = command;
    let selectedArguments = args;
    let windowsVerbatimArguments = false;
    if (platform === "win32") {
      const selected = resolveWindowsProviderExecutable(command, environment, {
        ...windowsExecutableLookup,
        cwd: options.cwd,
        allowBatch: true,
      });
      if (!selected.ok)
        throw new Error(
          `Experiment executable lookup failed for ${command}: ${selected.error.kind}. Select an absolute executable or correct PATH/PATHEXT.`,
          { cause: selected.error },
        );
      selectedCommand = selected.value;
      if (isWindowsBatchFile(selectedCommand)) {
        const invocation = windowsBatchCommand({
          environment,
          batchPath: selectedCommand,
          arguments: args,
        });
        selectedCommand = invocation.command;
        selectedArguments = invocation.arguments;
        windowsVerbatimArguments = true;
      }
    }
    try {
      await prepareOwnership(controller.signal);
    } catch (cause) {
      retainOwnedCommandCleanup(
        cause,
        preparationScope,
        "adb-ui-experiment",
        "prepare_command",
      );
      if (controller.signal.aborted && cause === controller.signal.reason)
        throw cancelled();
      throw cause;
    }
    const result = await runCommand(
      {
        command: selectedCommand,
        arguments: selectedArguments,
        windowsVerbatimArguments,
        runId: randomUUID(),
        expectedCommand: null,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        hostEnvironment: environment,
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
  const workFailures = failed ? [primary] : [];
  if (
    controller.signal.aborted &&
    !(
      primary instanceof OwnedCommandFailure &&
      primary.cancellation?.reason === controller.signal.reason
    )
  )
    workFailures.push(cancelled());
  if (failures.length) {
    const error = new AggregateError(
      [...workFailures, ...failures],
      "Experiment cleanup failed",
      { cause: primary },
    );
    error.cleanupOwners = owners;
    error.retryCleanup = settle;
    throw error;
  }
  if (workFailures.length === 1) throw workFailures[0];
  if (workFailures.length > 1)
    throw new AggregateError(
      workFailures,
      "Experiment work failed during cancellation",
      { cause: primary },
    );
  return value;
}
