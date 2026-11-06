import { constants } from "node:fs";
import { StagedOutputError } from "./StagedOutputError.js";
import type { Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";

import { OwnedFileHandle } from "./OwnedFileHandle.js";
import { sameDeviceIdentity } from "./RegularFile.js";

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

const identityOf = (stats: Stats): Identity => ({
  dev: stats.dev,
  ino: stats.ino,
});

const sameIdentity = (stats: Identity, identity: Identity): boolean =>
  sameDeviceIdentity(stats.dev, identity.dev) && stats.ino === identity.ino;

/**
 * Read identity from an open handle, then close it through the owner.
 * A failed close stays in `retained` so cleanup can retry it.
 * A successful close is removed: cleanup must not close that handle again.
 * `accept` runs after the identity is known and before close, so a close
 * failure does not drop an identity that was already read.
 */
export const identityFromRetainedHandle = async (
  retained: OwnedFileHandle[],
  raw: FileHandle,
  accept?: (identity: Identity) => void,
): Promise<Identity> => {
  const owned = new OwnedFileHandle(raw);
  retained.push(owned);
  const identity = identityOf(await raw.stat());
  accept?.(identity);
  await owned.close();
  const finished = retained.lastIndexOf(owned);
  if (finished >= 0) retained.splice(finished, 1);
  return identity;
};

/** One atomically staged file and directory retained through verified cleanup. */
export class OwnedStagedOutput {
  #file: OwnedFileHandle | undefined;
  #fileIdentity: Identity | undefined;
  #directoryIdentity: Identity | undefined;
  #retainedHandles: OwnedFileHandle[] = [];
  #fileClosed = false;
  #fileRemovedByOwner = false;
  #publishedRename = false;
  #closeAttempt: Promise<void> | undefined;
  #closed = false;
  #identityFailure: unknown;

  private constructor(readonly directory: string) {}

  static async create(directory: string): Promise<OwnedStagedOutput> {
    const owner = new OwnedStagedOutput(directory);
    try {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return owner;
      // Path stat on Windows reports device 0. The open handle reports the volume.
      await owner.#readIdentity(directory, (identity) => {
        owner.#directoryIdentity = identity;
      });
      return owner;
    } catch (cause: unknown) {
      // Keep this owner. A close failure must not drop an identity already read.
      owner.#identityFailure = cause;
      return owner;
    }
  }

  async #readIdentity(
    path: string,
    accept?: (identity: Identity) => void,
  ): Promise<Identity> {
    return identityFromRetainedHandle(
      this.#retainedHandles,
      await open(path, constants.O_RDONLY),
      accept,
    );
  }

  async #closeRetainedHandles(): Promise<void> {
    for (const handle of this.#retainedHandles) await handle.close();
  }

  setFile(file: OwnedFileHandle): void {
    if (this.#file !== undefined)
      throw new StagedOutputError("handle_already_owned");
    this.#file = file;
  }

  /** Verify the staged name against its descriptor after the last write. */
  async assertReadyForPublication(content: string): Promise<void> {
    await this.#verifiedDirectory();
    if (this.#file !== undefined && !this.#fileClosed)
      await this.#observeFileIdentity();
    if (this.#fileIdentity === undefined)
      throw new StagedOutputError("identity_unverified", undefined, {
        cause: this.#identityFailure,
      });
    const stagedFile = await lstat(content);
    if (!stagedFile.isFile() || stagedFile.isSymbolicLink())
      throw new StagedOutputError("identity_changed", { path: content });
    const stagedIdentity = await this.#readIdentity(content);
    if (!sameIdentity(stagedIdentity, this.#fileIdentity))
      throw new StagedOutputError("identity_changed", { path: content });
  }

  /** Observe the descriptor's identity after its last write, then close it. */
  async closeFile(): Promise<void> {
    const file = this.#file;
    if (file === undefined || this.#fileClosed) return;
    await this.#observeFileIdentity();
    await file.close();
    this.#fileClosed = true;
  }

  async #observeFileIdentity(): Promise<void> {
    const file = this.#file;
    if (file === undefined) return;
    // FAT and exFAT assign a file ID when the first write allocates storage,
    // so only the descriptor's final identity can prove the staged pathname.
    try {
      this.#fileIdentity = identityOf(await file.handle.stat());
    } catch (cause: unknown) {
      // The handle remains owned; cleanup will close it and refuse pathname removal.
      this.#fileIdentity = undefined;
      this.#identityFailure = cause;
    }
  }

  /** Record that the staged file moved to the published destination by rename. */
  recordPublishedRename(): void {
    this.#publishedRename = true;
  }

  /** Close the owned descriptor and remove only the exact staged entries. */
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    const attempt = Promise.resolve().then(() => this.#cleanup());
    this.#closeAttempt = attempt;
    void attempt.then(
      () => {
        this.#closed = true;
        this.#closeAttempt = undefined;
      },
      () => {
        this.#closeAttempt = undefined;
      },
    );
    return attempt;
  }

  async #cleanup(): Promise<void> {
    await this.#closeRetainedHandles();
    await this.closeFile();
    await this.#verifiedDirectory();

    // No descriptor was acquired when creating /content failed. Enumerate
    // the owned directory instead of probing a possibly overlong child path.
    if (this.#file !== undefined) {
      const content = `${this.directory}/content`;
      let stagedFile: Stats | undefined;
      try {
        stagedFile = await lstat(content);
      } catch (cause: unknown) {
        if (
          errorCode(cause) === "ENOENT" &&
          (this.#fileRemovedByOwner || this.#publishedRename)
        ) {
          stagedFile = undefined;
        } else if (errorCode(cause) === "ENOENT") {
          throw new StagedOutputError(
            "file_disappeared",
            { path: content },
            { cause },
          );
        } else {
          throw cause;
        }
      }
      if (stagedFile !== undefined) {
        if (
          !stagedFile.isFile() ||
          stagedFile.isSymbolicLink() ||
          this.#fileIdentity === undefined
        )
          throw new StagedOutputError("identity_changed", { path: content });
        const stagedIdentity = await this.#readIdentity(content);
        if (!sameIdentity(stagedIdentity, this.#fileIdentity))
          throw new StagedOutputError("identity_changed", { path: content });
        await unlink(content);
        this.#fileRemovedByOwner = true;
      }
    }

    const remaining = await readdir(this.directory);
    if (remaining.length > 0)
      throw new StagedOutputError("unexpected_entries", {
        count: remaining.length,
        entries: remaining.join(","),
      });
    await this.#verifiedDirectory();
    await rmdir(this.directory);
  }

  async #verifiedDirectory(): Promise<void> {
    if (this.#directoryIdentity === undefined)
      throw new StagedOutputError(
        "directory_unverified",
        { directory: this.directory },
        { cause: this.#identityFailure },
      );
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new StagedOutputError("directory_identity_changed", {
        directory: this.directory,
      });
    const directoryIdentity = await this.#readIdentity(this.directory);
    if (!sameIdentity(directoryIdentity, this.#directoryIdentity))
      throw new StagedOutputError("directory_identity_changed", {
        directory: this.directory,
      });
  }
}

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
