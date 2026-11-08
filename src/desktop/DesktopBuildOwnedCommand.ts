import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";

/** Run a setup command with ownership of its entire process family and partial output. */
export const runDesktopBuildOwnedCommand = async (input: {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly resources: ArtifactResourceScope;
  readonly partialPath?: string;
  readonly workspace?: string;
  readonly signal?: AbortSignal;
}): Promise<void> => {
  let retained = false;
  let cleanupReason: string | undefined;
  const paths = [input.partialPath, input.workspace].filter(
    (path): path is string => path !== undefined,
  );
  const removeOwnedPaths = async () => {
    const outcomes = await Promise.allSettled(
      paths.map((path) =>
        rm(path, { recursive: path === input.workspace, force: true }),
      ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Could not remove setup command outputs",
      );
  };
  try {
    await runOwnedCommand(
      {
        command: input.command,
        arguments: input.arguments,
        runId: randomUUID(),
        expectedCommand: null,
        hostEnvironment: input.environment,
        sweepTokenOwnedProcesses: true,
      },
      { timeoutMs: input.timeoutMs, diagnosticBytes: input.maxOutputBytes },
      {
        signal: input.signal,
        retainCleanup: (owner, result) => {
          retained = true;
          cleanupReason = result.reason;
          input.resources.retain({
            kind: "lease",
            resource:
              input.partialPath ??
              `setup process ${owner.launch.ownership?.runId ?? "unknown"}`,
            lease: new AnalysisCleanupLease(async () => {
              const stopped = await owner.stop();
              if (stopped.status === "incomplete")
                throw new Error(stopped.reason);
              await removeOwnedPaths();
            }, [
              ...paths,
              `setup process ${owner.launch.ownership?.runId ?? "unknown"}`,
            ]),
          });
        },
      },
    );
    if (retained)
      throw new Error(
        `Setup command cleanup incomplete: ${cleanupReason ?? "unknown reason"}`,
      );
  } catch (cause: unknown) {
    const preparation =
      cause instanceof DarwinProcessOwnershipInspectionError
        ? cause
        : cause instanceof OwnedCommandFailure
          ? cause.preparationFailure
          : undefined;
    if (preparation?.cleanupOwner !== undefined)
      input.resources.retain({
        kind: "lease",
        resource: "process ownership inspection",
        lease: { release: () => preparation.cleanupOwner!.close() },
      });
    if (!retained && paths.length > 0) {
      try {
        await removeOwnedPaths();
      } catch (cleanup: unknown) {
        input.resources.retain({
          kind: "lease",
          resource: paths[0]!,
          lease: new AnalysisCleanupLease(removeOwnedPaths, paths),
        });
        throw new AggregateError(
          [cause, cleanup],
          "Setup command failed and its partial output could not be removed",
        );
      }
    }
    if (retained)
      throw new Error(
        `${desktopBuildOwnedCommandReason(cause)}; cleanup is incomplete: ${cleanupReason ?? "unknown reason"}`,
        { cause },
      );
    throw cause;
  }
};

/** Keep the bounded command's stderr with its failure reason. */
export const desktopBuildOwnedCommandReason = (cause: unknown): string => {
  const command = cause instanceof OwnedCommandFailure ? cause : undefined;
  const stderr = command?.snapshot?.stderr.text.trim() ?? "";
  const message = cause instanceof Error ? cause.message : String(cause);
  return stderr === "" ? message : `${message}: ${stderr.slice(-2000)}`;
};
