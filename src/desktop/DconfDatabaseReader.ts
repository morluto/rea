import { realpath, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";

import {
  execFileOutput,
  execFileOutputFailure,
  ExecFileOutputCancelledError,
} from "../process/ExecFileOutput.js";

import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

const DCONF_TIMEOUT_MS = 30_000;
const DCONF_MAX_BUFFER = 16 * 1024 * 1024;

/** The keyfile text of a dconf database, or why it could not be read. */
export type DconfDump =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/**
 * Dump a staged dconf user database with `dconf dump /`. A profile written
 * beside it names the file relative to that private working directory. Paths
 * stay outside the profile's comment/line grammar; no live database is read.
 */
export const dumpDconfDatabase = async (
  database: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<DconfDump> => {
  assertArtifactReadActive(signal);
  try {
    const name = basename(database);
    // dconf strips # comments, LF-delimited lines and trailing ASCII whitespace.
    // Production staging uses "user"; refuse any unrepresentable leaf rather
    // than silently reading a different database.
    if (/[#\n]|[\t\v\f\r ]$/u.test(name))
      return {
        ok: false,
        error:
          "The staged dconf database filename cannot be represented in a dconf profile",
      };
    const directory = await realpath(dirname(database));
    const profile = join(directory, "profile");
    await writeFile(profile, `file-db:./${name}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const command = environment.REA_DCONF_COMMAND ?? "dconf";
    // Changing cwd must not change caller-selected commands or relative PATH entries.
    const startedIn = process.cwd();
    const fromOriginalDirectory = (path: string): string =>
      isAbsolute(path) ? path : `${startedIn}${sep}${path}`;
    const invocation =
      command.includes("/") || command.includes(sep)
        ? fromOriginalDirectory(command)
        : command;
    const searchPath = (environment.PATH ?? "")
      .split(delimiter)
      .map(fromOriginalDirectory)
      .join(delimiter);
    const { stdout } = await execFileOutput(invocation, ["dump", "/"], {
      cwd: directory,
      env: { PATH: searchPath, DCONF_PROFILE: profile },
      timeout: DCONF_TIMEOUT_MS,
      maxBuffer: DCONF_MAX_BUFFER,
      ...(signal === undefined ? {} : { signal }),
    });
    return { ok: true, text: stdout };
  } catch (cause: unknown) {
    if (cause instanceof ExecFileOutputCancelledError)
      throw new ArtifactReaderFailure("cancelled", "dconf dump was cancelled", {
        cause: cause.cause,
        cancellation: { reason: cause.cause },
      });
    const failure = execFileOutputFailure(cause);
    if (failure?.code === "ENOENT")
      return {
        ok: false,
        error: "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND",
      };
    return {
      ok: false,
      error: failure?.stderr.trim() || String(cause),
    };
  }
};
