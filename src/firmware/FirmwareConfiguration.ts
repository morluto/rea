import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { err, ok, type Result } from "../domain/result.js";

import {
  selectArtifactCommandPath,
  type ArtifactCommandPath,
} from "../process/ArtifactCommandPath.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

/** Match the execution adapter's default without requiring an environment override. */
export const firmwareLimiterPath = (
  environment: Readonly<NodeJS.ProcessEnv>,
): string => environment.REA_FIRMWARE_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";

/** Resolve a readable executable regular file; never search for or install tools. */
export const inspectFirmwareExecutable = async (
  path: string | undefined,
  variable: string,
  readable = true,
  signal?: AbortSignal,
): Promise<Result<ArtifactCommandPath, string>> => {
  if (path === undefined || !isAbsolute(path))
    return err(
      `${variable} must be an absolute path to a caller-supplied executable.`,
    );
  try {
    const selected = await selectArtifactCommandPath(path, signal);
    await access(
      selected.invocationPath,
      (readable ? constants.R_OK : 0) | constants.X_OK,
    );
    if (!(await stat(selected.invocationPath)).isFile())
      return err(
        `${variable} is not a readable executable regular file: ${path}`,
      );
    return ok(selected);
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    return err(
      `${variable} is unavailable at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};
