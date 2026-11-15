import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  ExecFileOutputCancelledError,
  execFileBytes,
} from "../process/ExecFileOutput.js";
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

/** Git metadata replies are paths and porcelain records, never bulk data. */
const GIT_METADATA_BYTES = 1024 * 1024;

const gitFailure = (
  cause: unknown,
): ConfigurationError | AnalysisCancelledError =>
  cause instanceof ExecFileOutputCancelledError
    ? new AnalysisCancelledError("Kilo project root discovery", {
        cause: cause.cause,
      })
    : new ConfigurationError(
        "Kilo project root could not be established by read-only Git metadata. Repair Git or repository access, or register globally; no client settings were written.",
        { cause },
      );

/**
 * Run one short read-only Git query. The query leads its own process group,
 * which the stop signal reaches on cancellation or timeout, so no
 * process-table ownership sweep is needed for these probes.
 */
const gitOutput = async (
  context: McpRegistrationLocationContext,
  cwd: string,
  arguments_: readonly string[],
): Promise<string> => {
  let observation: { readonly stdout: Buffer; readonly stderr: Buffer };
  try {
    observation = await execFileBytes("git", arguments_, {
      cwd,
      env: context.environment,
      timeout: 10_000,
      maxBuffer: GIT_METADATA_BYTES,
      stopSignal: "SIGTERM",
      windowsHide: true,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch (cause: unknown) {
    throw gitFailure(cause);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(observation.stdout);
  } catch {
    // The failure keeps the exact observation it could not decode.
    throw gitFailure(
      new Error("Git did not provide a complete UTF-8 metadata observation.", {
        cause: observation,
      }),
    );
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
        : gitFailure(cause);
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
