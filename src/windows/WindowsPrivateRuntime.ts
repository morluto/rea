import { win32 } from "node:path";

import { z } from "zod";

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

/** Retain private DACL and path handles until native recursive cleanup settles. */
export class WindowsPrivateRuntime {
  // One native snapshot can own cancellation for this runtime at a time. A
  // second request throws ERROR_BUSY before #pending or its abort listener is
  // replaced, so aborting a rejected request cannot cancel the accepted copy.
  #pending: Promise<unknown> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  private constructor(
    readonly observation: z.infer<typeof runtimeSchema>,
    private readonly authority: WindowsNativeAuthority,
  ) {}

  /** Create a new directory with its private DACL installed at creation. */
  static create(parent: string, prefix: string): WindowsPrivateRuntime {
    const authority = requireWindowsNativeAuthority();
    const observation = runtimeSchema.parse(
      authority.call("runtime_create", [parent, prefix]),
    );
    const runtime = new WindowsPrivateRuntime(observation, authority);
    runtimes.set(observation.path.toLowerCase(), runtime);
    return runtime;
  }

  /** Open a private child directory through retained, verified parent handles. */
  mkdir(relativePath: string): void {
    this.authority.call("runtime_mkdir", [
      this.observation.handle,
      relativePath,
    ]);
  }

  /** Write a new private file once and retain its immutable handle. */
  writeFile(relativePath: string, content: string): void {
    this.authority.call("runtime_write", [
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
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  /** Read a private endpoint from an opened file, without re-opening its path. */
  readFile(relativePath: string): string {
    const file = fileSchema.parse(
      this.authority.call("runtime_open", [
        this.observation.handle,
        relativePath,
      ]),
    );
    try {
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
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      this.authority.call("close", [file.handle]);
    }
  }

  /** Remove owned objects by handle, unlinking reparse entries without traversal. */
  close(): Promise<void> {
    this.#closePromise ??= this.#remove().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  async #remove(): Promise<void> {
    if (this.#closed) return;
    if (this.#pending !== undefined)
      this.authority.call("runtime_snapshot_cancel", [this.observation.handle]);
    await this.#pending?.catch(() => undefined);
    this.authority.call("runtime_close", [this.observation.handle]);
    this.#closed = true;
    runtimes.delete(this.observation.path.toLowerCase());
  }
}

/** Select an already-owned runtime; an arbitrary pathname cannot grant authority. */
export const windowsPrivateRuntime = (
  rootPath: string,
): WindowsPrivateRuntime => {
  const runtime = runtimes.get(rootPath.toLowerCase());
  if (runtime === undefined)
    throw new Error(`No native private runtime owns ${rootPath}`);
  return runtime;
};

/** Read a runtime endpoint using the lease that owns its parent directory. */
export const readWindowsPrivateRuntimeFile = (path: string): string => {
  const parent = win32.dirname(path);
  return windowsPrivateRuntime(parent).readFile(win32.basename(path));
};
