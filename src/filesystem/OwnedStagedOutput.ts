import { constants } from "node:fs";
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
 * The owner stays in `retained` so a failed close can be retried.
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
  return identity;
};

/** One atomically staged file and directory retained through verified cleanup. */
export class OwnedStagedOutput {
  #file: OwnedFileHandle | undefined;
  #fileIdentity: Identity | undefined;
  #directoryIdentity: Identity | undefined;
  #retainedHandles: OwnedFileHandle[] = [];
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

  async setFile(file: OwnedFileHandle): Promise<void> {
    if (this.#file !== undefined)
      throw new Error("Staged output already owns a file handle");
    this.#file = file;
    try {
      this.#fileIdentity = identityOf(await file.handle.stat());
    } catch (cause: unknown) {
      // The handle remains owned; cleanup will close it and refuse pathname removal.
      this.#identityFailure = cause;
    }
  }

  /** Verify that the path still names the exact closed file before publication. */
  async assertReadyForPublication(content: string): Promise<void> {
    await this.#verifiedDirectory();
    if (this.#fileIdentity === undefined)
      throw new Error("Cannot verify staged file identity", {
        cause: this.#identityFailure,
      });
    const stagedFile = await lstat(content);
    if (!stagedFile.isFile() || stagedFile.isSymbolicLink())
      throw new Error(`Staged file identity changed: ${content}`);
    const stagedIdentity = await this.#readIdentity(content);
    if (!sameIdentity(stagedIdentity, this.#fileIdentity))
      throw new Error(`Staged file identity changed: ${content}`);
  }

  closeFile(): Promise<void> {
    return this.#file?.close() ?? Promise.resolve();
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

    const content = `${this.directory}/content`;
    let stagedFile: Stats | undefined;
    try {
      stagedFile = await lstat(content);
    } catch (cause: unknown) {
      if (
        errorCode(cause) === "ENOENT" &&
        (this.#file === undefined ||
          this.#fileRemovedByOwner ||
          this.#publishedRename)
      ) {
        stagedFile = undefined;
      } else if (errorCode(cause) === "ENOENT") {
        throw new Error(`Owned staged file disappeared: ${content}`, {
          cause,
        });
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
        throw new Error(`Staged file identity changed: ${content}`);
      const stagedIdentity = await this.#readIdentity(content);
      if (!sameIdentity(stagedIdentity, this.#fileIdentity))
        throw new Error(`Staged file identity changed: ${content}`);
      await unlink(content);
      this.#fileRemovedByOwner = true;
    }

    const remaining = await readdir(this.directory);
    if (remaining.length > 0)
      throw new Error(
        `Unexpected staging entries remain in ${this.directory}: ${remaining.join(", ")}`,
      );
    await this.#verifiedDirectory();
    await rmdir(this.directory);
  }

  async #verifiedDirectory(): Promise<void> {
    if (this.#directoryIdentity === undefined)
      throw new Error(
        `Cannot verify staging directory ownership: ${this.directory}`,
        {
          cause: this.#identityFailure,
        },
      );
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error(`Staging directory identity changed: ${this.directory}`);
    const directoryIdentity = await this.#readIdentity(this.directory);
    if (!sameIdentity(directoryIdentity, this.#directoryIdentity))
      throw new Error(`Staging directory identity changed: ${this.directory}`);
  }
}

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
