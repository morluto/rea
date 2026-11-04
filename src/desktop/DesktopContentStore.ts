import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DesktopApplicationCapture } from "../domain/desktop/desktopCapture.js";

type Omission = DesktopApplicationCapture["state"]["omitted_content"][number];

/** A stored file, or why its bytes were left out. */
export type RetainOutcome =
  | {
      readonly kind: "retained";
      readonly sha256: string;
      readonly size: number;
    }
  | { readonly kind: "omitted"; readonly reason: Omission["reason"] };

/** Content-addressed copies of observed files under `<capture>/content`. */
export class DesktopContentStore {
  readonly #directory: string;
  readonly #maxFileBytes: number;
  readonly #stored = new Map<string, number>();
  readonly #omissions: Omission[] = [];
  #remainingBytes: number;

  constructor(
    captureDirectory: string,
    maxFileBytes: number,
    maxBytes: number,
  ) {
    this.#directory = join(captureDirectory, "content");
    this.#maxFileBytes = maxFileBytes;
    this.#remainingBytes = maxBytes;
  }

  /** Create the content directory before the first file is stored. */
  async prepare(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
  }

  get files(): number {
    return this.#stored.size;
  }

  get bytes(): number {
    return [...this.#stored.values()].reduce((sum, size) => sum + size, 0);
  }

  get omissions(): readonly Omission[] {
    return this.#omissions;
  }

  /** Copy one regular file if it fits and holds still while it is read. */
  async retain(path: string): Promise<RetainOutcome> {
    const outcome = await this.#read(path);
    if (outcome.kind === "omitted") {
      this.#omissions.push({ path, reason: outcome.reason });
      return outcome;
    }
    const { sha256, bytes } = outcome;
    if (!this.#stored.has(sha256)) {
      const target = join(this.#directory, sha256);
      const partial = `${target}.partial`;
      await writeFile(partial, bytes, { mode: 0o600 });
      await rename(partial, target);
      this.#stored.set(sha256, bytes.byteLength);
      this.#remainingBytes -= bytes.byteLength;
    }
    return { kind: "retained", sha256, size: bytes.byteLength };
  }

  async #read(
    path: string,
  ): Promise<
    | { readonly kind: "read"; readonly sha256: string; readonly bytes: Buffer }
    | Extract<RetainOutcome, { kind: "omitted" }>
  > {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return { kind: "omitted", reason: "unreadable" };
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return { kind: "omitted", reason: "unreadable" };
      if (before.size > BigInt(this.#maxFileBytes))
        return { kind: "omitted", reason: "too_large" };
      if (before.size > BigInt(this.#remainingBytes))
        return { kind: "omitted", reason: "budget_exhausted" };
      const bytes = await handle.readFile();
      const after = await lstat(path, { bigint: true }).catch(() => undefined);
      if (
        after === undefined ||
        BigInt(bytes.byteLength) !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ino !== before.ino
      )
        return { kind: "omitted", reason: "changed_during_read" };
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { kind: "read", sha256, bytes };
    } finally {
      await handle.close();
    }
  }
}
