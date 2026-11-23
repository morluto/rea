import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import {
  type AnalysisCancelledError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
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
  readonly primaryRoot: string | undefined;
}

export const pathWithin = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** Git metadata replies are paths and porcelain records, never bulk data. */
const GIT_METADATA_BYTES = 1024 * 1024;

type GitFailure = ConfigurationError | AnalysisCancelledError;

const gitFailure = (cause: unknown): GitFailure =>
  cause instanceof ExecFileOutputCancelledError
    ? cancelledBy("Kilo project root discovery", carriedReason(cause.cause))
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
): Promise<Result<string, GitFailure>> => {
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
    return err(gitFailure(cause));
  }
  try {
    return ok(decodeStrictUtf8(observation.stdout, "strip-signature"));
  } catch {
    // The failure keeps the exact observation it could not decode.
    return err(
      gitFailure(
        new Error(
          "Git did not provide a complete UTF-8 metadata observation.",
          {
            cause: observation,
          },
        ),
      ),
    );
  }
};

/** Each rev-parse invocation returns one path, so embedded whitespace remains path data. */
const gitPath = async (
  context: McpRegistrationLocationContext,
  cwd: string,
  field: string,
): Promise<Result<string, GitFailure>> => {
  const output = await gitOutput(context, cwd, ["rev-parse", field]);
  if (!output.ok) return output;
  const text = output.value;
  if (!text.endsWith("\n"))
    return err(
      new ConfigurationError(
        "Git metadata path has no protocol terminator; Kilo project root remains unknown.",
      ),
    );
  let value = text.slice(0, -1);
  if (context.platform === "win32" && value.endsWith("\r"))
    value = value.slice(0, -1);
  if (value.length === 0)
    return err(
      new ConfigurationError(
        "Git returned an empty path; Kilo project root remains unknown.",
      ),
    );
  return ok(absoluteCallerPath(value, { cwd, platform: context.platform }));
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
): Promise<Result<string | undefined, GitFailure>> => {
  if (gitDirectory === commonDirectory) return ok(root);
  // Kilo reads the first record. A bare repository has no primary checkout.
  const output = await gitOutput(context, root, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (!output.ok) return output;
  const listing = output.value;
  const record = listing.split("\0\0", 1)[0]?.split("\0");
  const field = record?.find((item) => item.startsWith("worktree "));
  if (field === undefined)
    return err(
      new ConfigurationError(
        "Kilo primary worktree is unknown; no project settings were written.",
      ),
    );
  const value = field.slice("worktree ".length);
  if (value.length === 0 || !listing.includes("\0\0"))
    return err(
      new ConfigurationError(
        "Git returned incomplete worktree metadata; no project settings were written.",
      ),
    );
  if (record?.includes("bare")) return ok(undefined);
  return directoryPath(
    absoluteCallerPath(value, { cwd: root, platform: context.platform }),
  );
};

const directoryPath = async (
  path: string,
): Promise<Result<string, GitFailure>> => {
  const resolved = await realpath(path);
  if (!(await lstat(resolved)).isDirectory())
    return err(
      new ConfigurationError(
        "Git metadata did not identify a directory; repair repository access or register globally. No settings were written.",
      ),
    );
  return ok(resolved);
};

const resolveWorktree = async (
  context: McpRegistrationLocationContext,
): Promise<Result<KiloRegistrationWorktree, GitFailure>> => {
  const active = await directoryPath(
    absoluteCallerPath(context.cwd, { platform: context.platform }),
  );
  if (!active.ok) return active;
  const activeDirectory = active.value;
  const gitCwd = await nearestGitDirectory(activeDirectory);
  if (gitCwd === undefined)
    return err(
      new ConfigurationError(
        "Kilo project registration needs a verified Git worktree boundary. Open a repository or register globally; no client settings were written.",
      ),
    );
  const readDirectory = async (field: string) => {
    const path = await gitPath(context, gitCwd, field);
    return path.ok ? directoryPath(path.value) : path;
  };
  const root = await readDirectory("--show-toplevel");
  if (!root.ok) return root;
  const gitDirectory = await readDirectory("--git-dir");
  if (!gitDirectory.ok) return gitDirectory;
  const commonDirectory = await readDirectory("--git-common-dir");
  if (!commonDirectory.ok) return commonDirectory;
  if (!pathWithin(root.value, activeDirectory))
    return err(
      new ConfigurationError(
        "Git's worktree does not contain the selected directory; Kilo project scope remains unknown.",
      ),
    );
  const primary = await primaryRoot(
    context,
    root.value,
    gitDirectory.value,
    commonDirectory.value,
  );
  return primary.ok
    ? ok({ activeDirectory, root: root.value, primaryRoot: primary.value })
    : primary;
};

/** Match the native nearest-.git and authoritative rev-parse worktree boundary. */
export const resolveKiloRegistrationWorktree = async (
  context: McpRegistrationLocationContext,
): Promise<Result<KiloRegistrationWorktree, GitFailure>> => {
  const result = await resolveWorktree(context).catch((cause: unknown) =>
    err(gitFailure(cause)),
  );
  if (!result.ok && context.signal?.aborted === true)
    analysisErrorWithCancellation(
      result.error,
      cancelledBy("Kilo project root discovery", context.signal),
    );
  return result;
};
