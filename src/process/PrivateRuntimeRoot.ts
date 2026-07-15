import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Filesystem coordinates for one provider-owned private runtime directory. */
export interface PrivateRuntimeRootOptions {
  readonly parent?: string;
  readonly prefix?: string;
}

/**
 * Owns one mode-0700 temporary runtime root and removes it idempotently.
 *
 * Protocol adapters decide what belongs inside the directory; this primitive
 * only establishes a private filesystem boundary and deterministic cleanup.
 */
export class PrivateRuntimeRoot {
  #closePromise: Promise<void> | undefined;

  private constructor(readonly path: string) {}

  /** Allocate a new private runtime root without performing protocol work. */
  static async create(
    options: PrivateRuntimeRootOptions = {},
  ): Promise<PrivateRuntimeRoot> {
    const path = await mkdtemp(
      join(options.parent ?? tmpdir(), options.prefix ?? "rea-provider-"),
    );
    try {
      await chmod(path, 0o700);
      return new PrivateRuntimeRoot(path);
    } catch (cause: unknown) {
      await rm(path, { recursive: true, force: true });
      throw cause;
    }
  }

  /** Remove the runtime root; concurrent and repeated callers share cleanup. */
  close(): Promise<void> {
    this.#closePromise ??= rm(this.path, { recursive: true, force: true });
    return this.#closePromise;
  }
}
