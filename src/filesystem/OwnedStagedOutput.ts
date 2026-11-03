import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";

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

/** Volume and file index from the open handle. Path stat on Windows omits the volume. */
const identityFromHandle = async (path: string): Promise<Identity> => {
  const handle = await open(path, constants.O_RDONLY);
  try {
    return identityOf(await handle.stat());
  } finally {
    await handle.close();
  }
};

/** One atomically staged file and directory retained through verified cleanup. */
export class OwnedStagedOutput {
  #file: OwnedFileHandle | undefined;
  #fileIdentity: Identity | undefined;
  #fileRemovedByOwner = false;
  #publishedRename = false;
  #closeAttempt: Promise<void> | undefined;
  #closed = false;
  #identityFailure: unknown;

  private constructor(
    readonly directory: string,
    private readonly directoryIdentity: Identity | undefined,
  ) {}

  static async create(directory: string): Promise<OwnedStagedOutput> {
    try {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        return new OwnedStagedOutput(directory, undefined);
      return new OwnedStagedOutput(
        directory,
        await identityFromHandle(directory),
      );
    } catch (cause: unknown) {
      // Keep an owner that refuses deletion when creation identity is unknown.
      const owner = new OwnedStagedOutput(directory, undefined);
      owner.#identityFailure = cause;
      return owner;
    }
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
    const stagedIdentity = await identityFromHandle(content);
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
      const stagedIdentity = await identityFromHandle(content);
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
    if (this.directoryIdentity === undefined)
      throw new Error(
        `Cannot verify staging directory ownership: ${this.directory}`,
        {
          cause: this.#identityFailure,
        },
      );
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error(`Staging directory identity changed: ${this.directory}`);
    const directoryIdentity = await identityFromHandle(this.directory);
    if (!sameIdentity(directoryIdentity, this.directoryIdentity))
      throw new Error(`Staging directory identity changed: ${this.directory}`);
  }
}

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
