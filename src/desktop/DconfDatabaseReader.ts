import { open, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import {
  execFileOutput,
  execFileOutputFailure,
  ExecFileOutputCancelledError,
} from "../process/ExecFileOutput.js";

import {
  assertArtifactReadActive,
  withArtifactFileHandle,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

import { programCandidates } from "./ProgramLookup.js";

const DCONF_NOT_INSTALLED =
  "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND";
const DCONF_TIMEOUT_MS = 30_000;
const DCONF_MAX_BUFFER = 16 * 1024 * 1024;

/** The keyfile text of a dconf database, or why it could not be read. */
export type DconfDump =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/**
 * Read an offline dconf database through the child's read-only stdin fd.
 * The profile contains no selected path syntax, and cwd/PATH stay unchanged for
 * wrapper interpreters and helpers. file-db has no live D-Bus authority.
 */
export const dumpDconfDatabase = async (
  database: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<DconfDump> => {
  assertArtifactReadActive(signal);
  try {
    const directory = await realpath(dirname(database));
    const profile = join(directory, "profile");
    await writeFile(profile, "file-db:/dev/fd/0\n", {
      mode: 0o600,
      flag: "wx",
    });
    const file = await open(database, "r");
    return await withArtifactFileHandle(
      database,
      file,
      undefined,
      signal,
      async (source) => {
        // dconf silently treats an unreadable file-db as empty. Refuse a host
        // without descriptor paths rather than publish a false empty view.
        await stat(`/dev/fd/${source.fd}`);
        const command = environment.REA_DCONF_COMMAND ?? "dconf";
        // Preserve the first refusal's candidate spelling for diagnostics. cwd and
        // PATH stay unchanged for interpreter and helper lookup as well.
        const startedIn = process.cwd();
        const direct = command.includes("/") || command.includes(sep);
        const candidates = direct
          ? [
              {
                path: isAbsolute(command)
                  ? command
                  : `${startedIn}${sep}${command}`,
              },
            ]
          : programCandidates(
              command,
              { PATH: environment.PATH ?? "" },
              startedIn,
            );
        let refusal: unknown;
        let missing: unknown;
        for (const candidate of candidates) {
          assertArtifactReadActive(signal);
          try {
            const { stdout } = await execFileOutput(
              candidate.path,
              ["dump", "/"],
              {
                stdinFile: source.fd,
                stopSignal: "SIGTERM",
                env: { PATH: environment.PATH ?? "", DCONF_PROFILE: profile },
                timeout: DCONF_TIMEOUT_MS,
                maxBuffer: DCONF_MAX_BUFFER,
                ...(signal === undefined ? {} : { signal }),
              },
            );
            return { ok: true, text: stdout };
          } catch (cause: unknown) {
            const failure = execFileOutputFailure(cause);
            // Only POSIX PATH-search spawn failures permit another candidate.
            // An actual child exit, cancellation or host capacity failure is final.
            if (
              !direct &&
              failure?.spawnFailed === true &&
              (failure.code === "ENOENT" ||
                failure.code === "ENOTDIR" ||
                failure.code === "EACCES")
            ) {
              if (failure.code === "EACCES") refusal ??= cause;
              else missing = cause;
              continue;
            }
            if (cause instanceof ExecFileOutputCancelledError)
              throw new ArtifactReaderFailure(
                "cancelled",
                "dconf dump was cancelled",
                {
                  cause: cause.cause,
                  cancellation: { reason: cause.cause },
                },
              );
            throw cause;
          }
        }
        if (refusal !== undefined) throw refusal;
        if (missing !== undefined) throw missing;
        return { ok: false, error: DCONF_NOT_INSTALLED };
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    const failure = execFileOutputFailure(cause);
    if (failure?.code === "ENOENT")
      return {
        ok: false,
        error: DCONF_NOT_INSTALLED,
      };
    return {
      ok: false,
      error: failure?.stderr.trim() || String(cause),
    };
  }
};
