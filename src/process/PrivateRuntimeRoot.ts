import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  windowsNativeCapabilities,
  type WindowsNativeCapability,
} from "./WindowsAuthority.js";

/** Filesystem coordinates for one provider-owned private runtime directory. */
export interface PrivateRuntimeRootOptions {
  readonly parent?: string;
  readonly prefix?: string;
  /** Platform override used by deterministic boundary tests. */
  readonly platform?: NodeJS.Platform;
}

/** Provider-neutral security status for one runtime-root implementation. */
export type PrivateRuntimeRootCapability =
  | WindowsNativeCapability
  | {
      readonly available: true;
      readonly reason: null;
      readonly proof: "posix-mode-0700";
    };

/** Report whether this process can establish a private runtime root. */
export const privateRuntimeRootCapability = (
  platform: NodeJS.Platform = process.platform,
): PrivateRuntimeRootCapability =>
  platform === "win32"
    ? windowsNativeCapabilities(platform).private_runtime_dacl
    : { available: true, reason: null, proof: "posix-mode-0700" };

/** Expected failure when a runtime root's privacy boundary is unavailable. */
export class PrivateRuntimeRootUnavailableError extends Error {
  readonly code = "private-runtime-root-authority-unavailable";

  constructor(message: string) {
    super(message);
    this.name = "PrivateRuntimeRootUnavailableError";
  }
}

/**
 * Owns one POSIX mode-0700 temporary runtime root and removes it idempotently.
 *
 * Protocol adapters decide what belongs inside the directory; this primitive
 * establishes a private filesystem boundary on POSIX and deterministic cleanup.
 * Windows privacy requires the separately verified native DACL boundary.
 */
export class PrivateRuntimeRoot {
  #closePromise: Promise<void> | undefined;

  private constructor(readonly path: string) {}

  /** Allocate a new private runtime root without performing protocol work. */
  static async create(
    options: PrivateRuntimeRootOptions = {},
  ): Promise<PrivateRuntimeRoot> {
    const platform = options.platform ?? process.platform;
    const capability = privateRuntimeRootCapability(platform);
    if (!capability.available)
      throw new PrivateRuntimeRootUnavailableError(capability.reason);
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
