import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { Evidence } from "../../domain/evidence.js";

/**
 * The physical spelling of a path that may not exist yet: the real path of
 * its longest existing ancestor followed by the rest. Walks, exclusions and
 * state directories compare in this spelling, so a symbolic link in the
 * caller's spelling cannot make one directory look like two.
 */
export const canonicalPath = async (path: string): Promise<string> => {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      if (dirname(current) === current) return absolute;
      rest.push(basename(current));
    }
  }
};

/** Why the output folder cannot hold a private capture. */
export type OutputRefusal = "not_a_directory" | "foreign_owner" | "not_empty";

/**
 * Create the output folder, or admit an existing empty one owned by this user,
 * and make it private. Returns its real path, or why it was refused.
 */
export const prepareOutputDirectory = async (
  output: string,
): Promise<{ readonly path: string } | { readonly refusal: OutputRefusal }> => {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const stats = await lstat(output);
  if (!stats.isDirectory()) return { refusal: "not_a_directory" };
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid)
    return { refusal: "foreign_owner" };
  if ((await readdir(output)).length > 0) return { refusal: "not_empty" };
  if ((stats.mode & 0o077) !== 0) await chmod(output, 0o700);
  return { path: await realpath(output) };
};

/** Publish `capture.json` through an exclusively created private file. */
export const writeCaptureFile = async (
  output: string,
  evidence: Evidence,
): Promise<string> => {
  const target = join(output, "capture.json");
  const partial = `${target}.partial`;
  await writeFile(partial, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(partial, target);
  return target;
};
