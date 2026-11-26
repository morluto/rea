import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

import {
  AnalysisCancelledError,
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

export type KiloWorktreeFailure = ConfigurationError | AnalysisCancelledError;

export const pathWithin = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** Git metadata replies are paths and porcelain records, never bulk data. */
const GIT_METADATA_BYTES = 1024 * 1024;

const gitFailure = (cause: unknown): KiloWorktreeFailure =>
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
): Promise<Result<string, KiloWorktreeFailure>> => {
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
): Promise<Result<string, KiloWorktreeFailure>> => {
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
): Promise<Result<string | undefined, KiloWorktreeFailure>> => {
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
): Promise<Result<string, ConfigurationError>> => {
  const resolved = await realpath(path);
  if (!(await lstat(resolved)).isDirectory())
    return err(
      new ConfigurationError(
        "Git metadata did not identify a directory; repair repository access or register globally. No settings were written.",
      ),
    );
  return ok(resolved);
};

const failWithCancellation = (
  context: McpRegistrationLocationContext,
  failure: KiloWorktreeFailure,
): Result<never, KiloWorktreeFailure> => {
  if (context.signal?.aborted === true)
    analysisErrorWithCancellation(
      failure,
      cancelledBy("Kilo project root discovery", context.signal),
    );
  return err(failure);
};

/** Match the native nearest-.git and authoritative rev-parse worktree boundary. */
export const resolveKiloRegistrationWorktree = async (
  context: McpRegistrationLocationContext,
): Promise<Result<KiloRegistrationWorktree, KiloWorktreeFailure>> => {
  try {
    const activeDirectory = await directoryPath(
      absoluteCallerPath(context.cwd, { platform: context.platform }),
    );
    if (!activeDirectory.ok)
      return failWithCancellation(context, activeDirectory.error);
    const gitCwd = await nearestGitDirectory(activeDirectory.value);
    if (gitCwd === undefined)
      return failWithCancellation(
        context,
        new ConfigurationError(
          "Kilo project registration needs a verified Git worktree boundary. Open a repository or register globally; no client settings were written.",
        ),
      );
    const toplevel = await gitPath(context, gitCwd, "--show-toplevel");
    if (!toplevel.ok) return failWithCancellation(context, toplevel.error);
    const root = await directoryPath(toplevel.value);
    if (!root.ok) return failWithCancellation(context, root.error);
    const rawGitDir = await gitPath(context, gitCwd, "--git-dir");
    if (!rawGitDir.ok) return failWithCancellation(context, rawGitDir.error);
    const gitDirectory = await directoryPath(rawGitDir.value);
    if (!gitDirectory.ok)
      return failWithCancellation(context, gitDirectory.error);
    const rawCommonDir = await gitPath(context, gitCwd, "--git-common-dir");
    if (!rawCommonDir.ok)
      return failWithCancellation(context, rawCommonDir.error);
    const commonDirectory = await directoryPath(rawCommonDir.value);
    if (!commonDirectory.ok)
      return failWithCancellation(context, commonDirectory.error);
    if (!pathWithin(root.value, activeDirectory.value))
      return failWithCancellation(
        context,
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
    if (!primary.ok) return failWithCancellation(context, primary.error);
    return ok({
      activeDirectory: activeDirectory.value,
      root: root.value,
      primaryRoot: primary.value,
    });
  } catch (cause: unknown) {
    return failWithCancellation(context, gitFailure(cause));
  }
};
