import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";

const DCONF_TIMEOUT_MS = 30_000;
const DCONF_MAX_BUFFER = 16 * 1024 * 1024;

/** The keyfile text of a dconf database, or why it could not be read. */
export type DconfDump =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/**
 * Dump a copied dconf user database with `dconf dump /`. A private profile
 * names the copy as a file database, so neither the user's live database nor
 * the dconf service is involved.
 */
export const dumpDconfDatabase = async (
  database: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<DconfDump> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-dconf-"));
  try {
    const copy = join(directory, "user");
    const profile = join(directory, "profile");
    await copyFile(database, copy);
    await writeFile(profile, `file-db:${copy}\n`, { mode: 0o600 });
    const command = environment.REA_DCONF_COMMAND ?? "dconf";
    const { stdout } = await execFileOutput(command, ["dump", "/"], {
      env: { PATH: environment.PATH ?? "", DCONF_PROFILE: profile },
      timeout: DCONF_TIMEOUT_MS,
      maxBuffer: DCONF_MAX_BUFFER,
      ...(signal === undefined ? {} : { signal }),
    });
    return { ok: true, text: stdout };
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    const failure = execFileOutputFailure(cause);
    if (failure?.code === "ENOENT")
      return {
        ok: false,
        error: "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND",
      };
    return {
      ok: false,
      error: failure === undefined ? String(cause) : failure.stderr.trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
