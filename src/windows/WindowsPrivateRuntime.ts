import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";

import {
  requireWindowsNativeAuthority,
  windowsFileIdentitySchema,
  windowsHandleSchema,
  type WindowsNativeAuthority,
} from "./WindowsNativeLoader.js";

const runtimeSchema = windowsFileIdentitySchema.extend({
  path: z.string(),
  handle: windowsHandleSchema,
  privateDacl: z.literal(true),
});
const snapshotSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: windowsFileIdentitySchema,
  snapshot: windowsFileIdentitySchema,
});
const fileSchema = windowsFileIdentitySchema.extend({
  handle: windowsHandleSchema,
});
const runtimes = new Map<string, WindowsPrivateRuntime>();
// Retry only a proven pre-allocation sharing/lock conflict, never opaque text
// or an operation that may already own an unpublished runtime directory.
const transientRuntimeAdmissionSchema = z.object({
  code: z.literal("ERR_REA_WINDOWS_NATIVE"),
  win32Code: z.union([z.literal(32), z.literal(33)]),
  runtimeAllocation: z.literal("not-started"),
});
const transientRuntimeCleanupSchema = z.object({
  code: z.literal("ERR_REA_WINDOWS_NATIVE"),
  win32Code: z.union([z.literal(32), z.literal(33)]),
});
const snapshotCancellationSchema = z.object({
  code: z.literal("ERR_REA_WINDOWS_NATIVE"),
  win32Code: z.literal(995),
});

/** A native snapshot acknowledged cancellation, with the caller reason retained. */
export class WindowsSnapshotCancelledError extends Error {
  constructor(
    readonly reason: unknown,
    cause: unknown,
  ) {
    super("Windows snapshot cancelled", { cause });
    this.name = "WindowsSnapshotCancelledError";
  }
}

const RUNTIME_CLEANUP_ATTEMPTS = 10;
const RUNTIME_CLEANUP_RETRY_DELAY_MS = 100;

/** Retain private DACL and path handles until native recursive cleanup settles. */
export class WindowsPrivateRuntime {
  // One native snapshot can own cancellation for this runtime at a time. A
  // second request throws ERROR_BUSY before #pending or its abort listener is
  // replaced, so aborting a rejected request cannot cancel the accepted copy.
  #pending: Promise<unknown> | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  // Admitted files whose close failed. Removal retries these wrappers before
  // the native tree walk. Dropping them leaves ancestor handles until GC, and
  // those handles can make runtime_close fail with a sharing violation.
  #unreleasedFiles: AnalysisCleanupLease[] = [];
  private constructor(
    readonly observation: z.infer<typeof runtimeSchema>,
    private readonly authority: WindowsNativeAuthority,
  ) {}

  /** Create a new directory with its private DACL installed at creation. */
  static create(parent: string, prefix: string): WindowsPrivateRuntime {
    const authority = requireWindowsNativeAuthority();
    let observed: unknown;
    try {
      observed = authority.call("runtime_create", [parent, prefix]);
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        transientRuntimeAdmissionSchema.safeParse(cause).success
      )
        throw new PrivateRuntimeRootUnavailableError(cause.message, {
          cause,
          retryable: true,
        });
      throw cause;
    }
    const observation = runtimeSchema.parse(observed);
    const runtime = new WindowsPrivateRuntime(observation, authority);
    runtimes.set(windowsRuntimeIdentityKey(observation), runtime);
    return runtime;
  }

  /** Open a private child directory through retained, verified parent handles. */
  mkdir(relativePath: string): void {
    this.#assertOpen();
    this.authority.call("runtime_mkdir", [
      this.observation.handle,
      relativePath,
    ]);
  }

  /** Write a new private file once and retain its immutable handle. */
  writeFile(relativePath: string, content: string): void {
    this.#assertOpen();
    this.authority.call("runtime_write", [
      this.observation.handle,
      relativePath,
      Buffer.from(content),
    ]);
  }

  /**
   * Write a new private file once, flush, and close the writer without retaining
   * it in `immutableFiles`. Use for staged job inputs that a child must read and
   * the parent must later `rm` while the runtime lease stays open.
   */
  writeTransientFile(relativePath: string, content: string): void {
    this.#assertOpen();
    this.authority.call("runtime_write_transient", [
      this.observation.handle,
      relativePath,
      Buffer.from(content),
    ]);
  }

  /** Copy admitted source bytes and digest the bytes actually written. */
  async snapshot(
    sourcePath: string,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof snapshotSchema>> {
    this.#assertOpen();
    // Admission is synchronous; record ownership only after native acceptance.
    const pending = Promise.resolve(
      this.authority.call("runtime_snapshot", [
        this.observation.handle,
        sourcePath,
        relativePath,
      ]),
    );
    this.#pending = pending;
    const cancel = (): void => {
      this.authority.call("runtime_snapshot_cancel", [this.observation.handle]);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true) cancel();
    try {
      return snapshotSchema.parse(await pending);
    } catch (cause: unknown) {
      if (
        signal?.aborted === true &&
        snapshotCancellationSchema.safeParse(cause).success
      )
        throw new WindowsSnapshotCancelledError(signal.reason, cause);
      throw cause;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  /** Read a private endpoint from an opened file, without re-opening its path. */
  readFile(relativePath: string, maximumBytes: number): string {
    this.#assertOpen();
    const file = fileSchema.parse(
      this.authority.call("runtime_open", [
        this.observation.handle,
        relativePath,
      ]),
    );
    let text: string | undefined;
    let primary: { readonly cause: unknown } | undefined;
    let closeFailure:
      | { readonly cause: unknown; readonly lease: AnalysisCleanupLease }
      | undefined;
    try {
      if (file.size > maximumBytes)
        throw new ArtifactReaderFailure(
          "limit",
          `Private runtime file exceeds its ${String(maximumBytes)}-byte bound`,
        );
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < file.size;) {
        const value = z
          .instanceof(Buffer)
          .parse(
            this.authority.call("read", [
              file.handle,
              offset,
              Math.min(65_536, file.size - offset),
            ]),
          );
        if (value.length === 0)
          throw new Error(
            "Private runtime file ended before its observed size",
          );
        offset += value.length;
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch (cause: unknown) {
      primary = { cause };
    } finally {
      try {
        this.authority.call("close", [file.handle]);
      } catch (cause: unknown) {
        const lease = new AnalysisCleanupLease(async () => {
          this.authority.call("close", [file.handle]);
        }, [file.requestedPath]);
        this.#unreleasedFiles.push(lease);
        closeFailure = { cause, lease };
      }
    }
    if (closeFailure !== undefined)
      throw ArtifactReaderFailure.withCleanup(
        primary === undefined ? closeFailure.cause : primary.cause,
        {
          reason:
            closeFailure.cause instanceof Error
              ? closeFailure.cause.message
              : String(closeFailure.cause),
          resources: [file.requestedPath],
        },
        undefined,
        [closeFailure.lease],
      );
    if (primary !== undefined) throw primary.cause;
    if (text === undefined)
      throw new Error("Private runtime read completed without text");
    return text;
  }

  /** Remove owned objects by handle, unlinking reparse entries without traversal. */
  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#remove().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closing)
      throw new Error(
        "Windows private runtime cleanup is in progress or complete",
      );
  }

  async #remove(): Promise<void> {
    if (this.#closed) return;
    if (this.#pending !== undefined)
      this.authority.call("runtime_snapshot_cancel", [this.observation.handle]);
    await this.#pending?.catch(() => undefined);
    await this.#closeRuntime();
    this.#closed = true;
    runtimes.delete(windowsRuntimeIdentityKey(this.observation));
  }

  /** Close admitted files that survived readFile before walking the tree. */
  async #releaseAdmittedFiles(): Promise<void> {
    const pending = this.#unreleasedFiles.splice(0);
    let failure: unknown;
    for (const lease of pending) {
      try {
        await lease.release();
      } catch (cause: unknown) {
        this.#unreleasedFiles.push(lease);
        failure ??= cause;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async #closeRuntime(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#releaseAdmittedFiles();
        this.authority.call("runtime_close", [this.observation.handle]);
        return;
      } catch (cause: unknown) {
        if (
          attempt >= RUNTIME_CLEANUP_ATTEMPTS ||
          !transientRuntimeCleanupSchema.safeParse(cause).success
        )
          throw cause;
        // Native cleanup retains the same owned root and permits only another
        // close after a failed walk. Retry that owner operation briefly when
        // Windows reports a sharing/lock conflict; other errors remain final.
        await delay(RUNTIME_CLEANUP_RETRY_DELAY_MS);
      }
    }
  }
}

/** File id returned by the OS. Path spelling is not part of the lease key. */
const windowsRuntimeIdentityKey = (identity: {
  readonly volumeSerial: string;
  readonly fileId: string;
}): string => `${identity.volumeSerial}:${identity.fileId}`;

/**
 * Select an already-owned runtime. Only the observed `path` or `finalPath`
 * matches, character for character. A case variant fails closed.
 */
export const windowsPrivateRuntime = (
  rootPath: string,
): WindowsPrivateRuntime => {
  const matches = [...runtimes.values()].filter(
    (runtime) =>
      runtime.observation.finalPath === rootPath ||
      runtime.observation.path === rootPath,
  );
  const runtime = matches[0];
  if (matches.length !== 1 || runtime === undefined)
    throw new Error(`No native private runtime owns ${rootPath}`);
  return runtime;
};

/** Read a runtime endpoint using the lease that owns its parent directory. */
export const readWindowsPrivateRuntimeFile = (
  path: string,
  maximumBytes: number,
): string => {
  const parent = win32.dirname(path);
  return windowsPrivateRuntime(parent).readFile(
    win32.basename(path),
    maximumBytes,
  );
};
