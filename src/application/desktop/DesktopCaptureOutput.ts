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
import { join } from "node:path";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { Evidence } from "../../domain/evidence.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";

/** Why the output folder cannot hold a private capture. */
export type OutputRefusal = "not_a_directory" | "foreign_owner" | "not_empty";

/**
 * Create the output folder, or admit an existing empty one owned by this user,
 * and make it private. Returns its real path, or why it was refused.
 */
export const prepareOutputDirectory = async (
  output: string,
): Promise<{ readonly path: string } | { readonly refusal: OutputRefusal }> => {
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
  } catch (cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR")
      return { refusal: "not_a_directory" };
    throw cause;
  }
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
  /** The partial file's handle when its close failed; kept owned so `close` can retry it. */
  readonly #unclosed = new ArtifactResourceScope();

  constructor(output: string) {
    this.partial = join(output, "capture.json.partial");
    this.#target = join(output, "capture.json");
  }

  /**
   * Write the evidence and rename it into place; returns the published path.
   * A failed write is reported ahead of a failed close, and a handle whose
   * close failed stays owned until `close` releases it.
   */
  async publish(evidence: Evidence): Promise<string> {
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    const handle = new OwnedFileHandle(await open(this.partial, "wx", 0o600));
    this.#created = true;
    const written = await handle.handle.writeFile(text).then(
      () => undefined,
      (cause: unknown) => ({ cause }),
    );
    const closed = await this.#unclosed.release({
      kind: "file-handle",
      resource: this.partial,
      handle,
    });
    if (written !== undefined) throw written.cause;
    if (closed.kind === "failed") throw closed.cause;
    await rename(this.partial, this.#target);
    this.#created = false;
    return this.#target;
  }

  /**
   * Retry the partial file's failed close. A handle that fails again stays
   * owned, and the rejection carries its exact cleanup lease.
   */
  close(): Promise<void> {
    return this.#unclosed.retryCleanup();
  }

  /** Remove the partial file, only when this run created it. */
  async discard(): Promise<void> {
    if (!this.#created) return;
    await rm(this.partial, { force: true });
    this.#created = false;
  }
}
