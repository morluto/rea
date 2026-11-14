import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  bindProcessInspectionCancellations,
  processInspectionCancellationError,
  retainOwnedCommandCleanup,
} from "../providers/OwnedCommandCleanup.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  OwnedCommandFailure,
  prepareOwnedCommand,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { McpRegistrationLocationContext } from "./McpRegistrationLocations.js";

/** Git's observed active and primary worktree roots; neither grants mutation authority. */
export interface KiloRegistrationWorktree {
  readonly activeDirectory: string;
  readonly root: string;
  readonly primaryRoot: string;
}

export const pathWithin = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

const retainGitCleanup = (
  cause: unknown,
  context: McpRegistrationLocationContext,
): readonly AnalysisError[] =>
  retainOwnedCommandCleanup(
    cause,
    {
      retain: (owner, resource) =>
        context.resources.retain({
          kind: "lease",
          resource,
          lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
        }),
      run: (work) => work(),
    },
    "mcp-registration",
    "Kilo project root discovery",
  );

const gitFailure = (
  cause: unknown,
  context: McpRegistrationLocationContext,
): ConfigurationError | AnalysisCancelledError => {
  const cleanups = retainGitCleanup(cause, context);
  const cleanup =
    cleanups.length === 0
      ? undefined
      : {
          reason: "Read-only Git discovery cleanup remains incomplete.",
          resources: cleanups.flatMap((failure) => failure.cleanupResources),
        };
  const cancellation =
    cause instanceof OwnedCommandFailure ? cause.cancellation : undefined;
  const inspectionCancellation = processInspectionCancellationError(
    cause,
    "Kilo project root discovery",
  );
  const primaryCancellation =
    inspectionCancellation !== undefined ||
    (cause instanceof OwnedCommandFailure && cause.reason === "cancelled");
  const cancelled =
    inspectionCancellation === undefined && cancellation === undefined
      ? undefined
      : new AnalysisCancelledError("Kilo project root discovery", {
          cause:
            inspectionCancellation === undefined
              ? cancellation?.reason
              : inspectionCancellation.cause,
          ...(inspectionCancellation?.capturedOutput === undefined
            ? {}
            : { capturedOutput: inspectionCancellation.capturedOutput }),
          ...(!primaryCancellation || cleanup === undefined ? {} : { cleanup }),
        });
  const failure =
    primaryCancellation && cancelled !== undefined
      ? cancelled
      : new ConfigurationError(
          "Kilo project root could not be established by read-only Git metadata. Repair Git or repository access, or register globally; no client settings were written.",
          { cause, ...(cleanup === undefined ? {} : { cleanup }) },
        );
  if (cancelled !== undefined && failure !== cancelled)
    analysisErrorWithCancellation(failure, cancelled);
  if (cleanups.length > 0) failure.bindCleanupDependencies(cleanups);
  bindProcessInspectionCancellations(
    cause,
    failure,
    "Kilo project root discovery",
  );
  return failure;
};

const gitOutput = async (
  context: McpRegistrationLocationContext,
  cwd: string,
  arguments_: readonly string[],
): Promise<string> => {
  try {
    await prepareOwnedCommand(context.signal);
    const result = await runOwnedCommand(
      {
        command: "git",
        arguments: arguments_,
        cwd,
        runId: randomUUID(),
        expectedCommand: null,
        hostEnvironment: context.environment,
        sweepTokenOwnedProcesses: true,
      },
      { timeoutMs: 10_000, diagnosticBytes: 1024 * 1024 },
      { signal: context.signal },
    );
    if (
      result.stdout.invalidUtf8 ||
      result.diagnosticTruncated ||
      result.outputIncomplete
    )
      throw new Error(
        "Git did not provide a complete UTF-8 metadata observation.",
        { cause: result },
      );
    return result.stdout.text;
  } catch (cause: unknown) {
    throw gitFailure(cause, context);
  }
};

/** Each rev-parse invocation returns one path, so embedded whitespace remains path data. */
const gitPath = async (
  context: McpRegistrationLocationContext,
  cwd: string,
  field: string,
): Promise<string> => {
  const text = await gitOutput(context, cwd, ["rev-parse", field]);
  if (!text.endsWith("\n"))
    throw new ConfigurationError(
      "Git metadata path has no protocol terminator; Kilo project root remains unknown.",
    );
  let value = text.slice(0, -1);
  if (context.platform === "win32" && value.endsWith("\r"))
    value = value.slice(0, -1);
  if (value.length === 0)
    throw new ConfigurationError(
      "Git returned an empty path; Kilo project root remains unknown.",
    );
  return absoluteCallerPath(value, { cwd, platform: context.platform });
};

const nearestGitDirectory = async (
  cwd: string,
): Promise<string | undefined> => {
  let directory = cwd;
  while (true) {
    try {
      await lstat(`${directory}${directory.endsWith(sep) ? "" : sep}.git`);
      return directory;
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const primaryRoot = async (
  context: McpRegistrationLocationContext,
  root: string,
  gitDirectory: string,
  commonDirectory: string,
): Promise<string> => {
  if (gitDirectory === commonDirectory) return root;
  // Kilo's primaryPaths uses the first non-bare porcelain worktree record.
  const listing = await gitOutput(context, root, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const record = listing.split("\0\0", 1)[0]?.split("\0");
  const field = record?.find((item) => item.startsWith("worktree "));
  if (field === undefined || record?.includes("bare"))
    throw new ConfigurationError(
      "Kilo primary worktree is unknown; no project settings were written.",
    );
  const value = field.slice("worktree ".length);
  if (value.length === 0 || !listing.includes("\0\0"))
    throw new ConfigurationError(
      "Git returned incomplete worktree metadata; no project settings were written.",
    );
  return directoryPath(
    absoluteCallerPath(value, { cwd: root, platform: context.platform }),
  );
};

const directoryPath = async (path: string): Promise<string> => {
  const resolved = await realpath(path);
  if (!(await lstat(resolved)).isDirectory())
    throw new ConfigurationError(
      "Git metadata did not identify a directory; repair repository access or register globally. No settings were written.",
    );
  return resolved;
};

/** Match the native nearest-.git and authoritative rev-parse worktree boundary. */
export const resolveKiloRegistrationWorktree = async (
  context: McpRegistrationLocationContext,
): Promise<KiloRegistrationWorktree> => {
  try {
    const activeDirectory = await directoryPath(
      absoluteCallerPath(context.cwd, { platform: context.platform }),
    );
    const gitCwd = await nearestGitDirectory(activeDirectory);
    if (gitCwd === undefined)
      throw new ConfigurationError(
        "Kilo project registration needs a verified Git worktree boundary. Open a repository or register globally; no client settings were written.",
      );
    const root = await directoryPath(
      await gitPath(context, gitCwd, "--show-toplevel"),
    );
    const gitDirectory = await directoryPath(
      await gitPath(context, gitCwd, "--git-dir"),
    );
    const commonDirectory = await directoryPath(
      await gitPath(context, gitCwd, "--git-common-dir"),
    );
    if (!pathWithin(root, activeDirectory))
      throw new ConfigurationError(
        "Git's worktree does not contain the selected directory; Kilo project scope remains unknown.",
      );
    return {
      activeDirectory,
      root,
      primaryRoot: await primaryRoot(
        context,
        root,
        gitDirectory,
        commonDirectory,
      ),
    };
  } catch (cause: unknown) {
    const failure =
      cause instanceof ConfigurationError ||
      cause instanceof AnalysisCancelledError
        ? cause
        : gitFailure(cause, context);
    if (context.signal?.aborted === true)
      analysisErrorWithCancellation(
        failure,
        new AnalysisCancelledError("Kilo project root discovery", {
          cause: context.signal.reason,
        }),
      );
    throw failure;
  }
};
