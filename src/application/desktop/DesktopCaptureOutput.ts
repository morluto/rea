import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
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

/** `capture.json`, published through a private partial file this run creates. */
export class CaptureFile {
  readonly partial: string;
  readonly #target: string;
  /** Whether this run created the partial file and has not published or removed it. */
  #created = false;

  constructor(output: string) {
    this.partial = join(output, "capture.json.partial");
    this.#target = join(output, "capture.json");
  }

  /** Write the evidence and rename it into place; returns the published path. */
  async publish(evidence: Evidence): Promise<string> {
    const handle = await open(this.partial, "wx", 0o600);
    this.#created = true;
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(this.partial, this.#target);
    this.#created = false;
    return this.#target;
  }

  /** Remove the partial file, only when this run created it. */
  async discard(): Promise<void> {
    if (!this.#created) return;
    await rm(this.partial, { force: true });
    this.#created = false;
  }
}
