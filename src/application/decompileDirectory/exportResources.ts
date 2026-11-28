import {
  link,
  lstat,
  mkdtemp,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  AnalysisCleanupLease,
  ArtifactFileCleanupFailure,
  ArtifactReaderFailure,
  ArtifactResourceScope,
} from "../../resources/index.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import { DECOMPILE_DIRECTORY_JOURNAL_NAME } from "../../contracts/decompileDirectory.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../../domain/result.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { OwnedStagedOutput } from "../../filesystem/OwnedStagedOutput.js";
import {
  hashStableFile,
  stableFileHashCause,
} from "../../filesystem/StableFileHash.js";
import type { OwnedLease } from "../../process/OwnedLease.js";
import type { RetainedResourceScope } from "../../ports/AnalysisProvider.js";

/** Publication committed before its staging cleanup failed. */
export class ExportPublishedCleanupFailure extends ArtifactReaderFailure {
  constructor(
    readonly publishedPath: string,
    failure: ArtifactReaderFailure,
  ) {
    super(
      failure.reason,
      failure.message,
      {
        cause: failure,
        ...failure.primaryFacts(),
        cancellation: failure.cancellation,
        cleanup: failure.cleanup,
        cleanupLeases: failure.cleanupLeases,
        partialObservation: failure.partialObservation,
      },
      failure.details,
    );
  }
}

/** Bytes written and synced in an owned staging directory, not yet published. */
export type StagedExportFile =
  | {
      readonly owner: {
        readonly kind: "staged-output";
        readonly resource: string;
        readonly output: OwnedStagedOutput;
      };
      readonly path: string;
      readonly failure: { readonly cause: unknown } | undefined;
    }
  /** The staging directory could not be created. */
  | {
      readonly owner: undefined;
      readonly failure: { readonly cause: unknown };
    };

/** Own every descriptor and staging area until cleanup, then release the directory lease. */
export class ExportResources {
  readonly #files = new ArtifactResourceScope();
  readonly #cleanup: AnalysisCleanupLease;
  #removeRoot = false;
  #journalIdentity: FileIdentity | undefined;
  #rootRemoved = false;
  #retained = false;
  #functionsRemoved = false;
  #journalRemoved = false;
  #leaseReleased = false;
  #functionsIdentity: FileIdentity | undefined;

  constructor(
    readonly root: string,
    private readonly identity: FileIdentity,
    private readonly lease: OwnedLease,
    private readonly scope: RetainedResourceScope | undefined,
  ) {
    const resources = this;
    this.#cleanup = AnalysisCleanupLease.forCloseOwner(
      {
        close: async () => {
          await this.#files.retryCleanup();
          if (this.#removeRoot && !this.#rootRemoved)
            await this.#removeCreatedRoot();
          await this.lease.release();
          this.#leaseReleased = true;
        },
        get cleanupResources() {
          return resources.cleanupResources;
        },
      },
      root,
    );
  }

  get cleanupResources(): readonly string[] {
    return [
      ...this.#files.cleanupResources,
      ...(this.#removeRoot && !this.#rootRemoved ? [this.root] : []),
      ...(this.#leaseReleased ? [] : [this.lease.socketPath ?? this.root]),
    ];
  }

  ownFunctionsDirectory(identity: FileIdentity): void {
    this.#functionsIdentity = identity;
  }

  ownFile(handle: FileHandle, path: string, journal = false) {
    const file = new OwnedFileHandle(handle);
    const owner = {
      kind: "lease" as const,
      resource: path,
      lease: {
        release: async () => {
          if (journal && handle.fd >= 0)
            this.#journalIdentity = await handle
              .stat({ bigint: true })
              .catch(() => undefined);
          await file.close();
        },
      },
    };
    this.#files.retain(owner);
    return async (): Promise<boolean> =>
      (await this.#files.release(owner)).kind === "released";
  }

  /** Check existing output with bounded memory and the shared file identity owner. */
  async hashFile(path: string, signal?: AbortSignal): Promise<string> {
    let cleanupLease: AnalysisCleanupLease | undefined;
    try {
      const hash = await hashStableFile(path, {
        ...(signal === undefined ? {} : { signal }),
        retainFailedClose: (handle) => {
          cleanupLease = new AnalysisCleanupLease(() => handle.close(), [path]);
          this.#files.retain({
            kind: "lease",
            resource: path,
            lease: cleanupLease,
          });
        },
      });
      return hash.sha256;
    } catch (cause: unknown) {
      if (
        cause instanceof RegularFileCleanupFailure &&
        cleanupLease !== undefined
      )
        throw new ArtifactFileCleanupFailure(cause, cleanupLease);
      throw stableFileHashCause(cause);
    }
  }

  /** Publish only a verified staged file; failed close or removal stays owned. */
  async publish(
    bytes: string | Buffer,
    destination: string,
    mode: "link" | "rename",
  ): Promise<void> {
    await this.publishStaged(await this.stage(bytes), destination, mode);
  }

  /**
   * Write and sync bytes in an owned staging directory without publishing
   * them. Never rejects: a failure stays with the staging owner and is thrown
   * by `publishStaged`, so staging can run ahead of publication. Cleanup waits
   * for staging in flight, so closing never removes a directory still in use.
   */
  stage(bytes: string | Buffer): Promise<StagedExportFile> {
    return this.#files
      .track(() => this.#stage(bytes))
      .catch((cause: unknown) => ({ owner: undefined, failure: { cause } }));
  }

  async #stage(bytes: string | Buffer): Promise<StagedExportFile> {
    let directory: string;
    try {
      directory = await mkdtemp(join(this.root, ".decompile-stage-"));
    } catch (cause: unknown) {
      return { owner: undefined, failure: { cause } };
    }
    const staging = await OwnedStagedOutput.create(directory);
    const owner = {
      kind: "staged-output" as const,
      resource: directory,
      output: staging,
    };
    this.#files.retain(owner);
    const path = join(directory, "content");
    try {
      const handle = await open(path, "wx", 0o600);
      staging.setFile(new OwnedFileHandle(handle));
      await handle.writeFile(bytes);
      await handle.sync();
      await staging.closeFile();
      return { owner, path, failure: undefined };
    } catch (cause: unknown) {
      return { owner, path, failure: { cause } };
    }
  }

  /** Publish a staged file under its final name, then release its staging. */
  async publishStaged(
    staged: StagedExportFile,
    destination: string,
    mode: "link" | "rename",
  ): Promise<void> {
    if (staged.owner === undefined) throw staged.failure.cause;
    const { owner, path } = staged;
    let outcome:
      | { readonly kind: "completed" }
      | { readonly kind: "failed"; readonly cause: unknown } =
      staged.failure === undefined
        ? { kind: "completed" }
        : { kind: "failed", cause: staged.failure.cause };
    if (outcome.kind === "completed")
      try {
        await owner.output.assertReadyForPublication(path);
        if (mode === "link") await link(path, destination);
        else {
          await rename(path, destination);
          owner.output.recordPublishedRename();
        }
      } catch (cause: unknown) {
        outcome = { kind: "failed", cause };
      }
    const released = await this.#files.release(owner);
    if (released.kind === "failed") {
      const failure = this.#files.cleanupFailure(outcome, [released]);
      throw outcome.kind === "completed"
        ? new ExportPublishedCleanupFailure(destination, failure)
        : failure;
    }
    if (outcome.kind === "failed") throw outcome.cause;
  }

  /**
   * Remove a staged file that will not be published. A failed removal stays
   * owned by this export, which retries and reports it when it closes.
   */
  async discardStaged(staged: StagedExportFile): Promise<void> {
    if (staged.owner !== undefined) await this.#files.release(staged.owner);
  }

  /** Keep the lease through all initialization cleanup, including any retry. */
  async failedInitialization(
    error: AnalysisError,
  ): Promise<Result<never, AnalysisError>> {
    this.#removeRoot = true;
    const closed = await this.close();
    return closed.ok
      ? err(error)
      : err(
          analysisErrorWithCleanupDependencies(
            error,
            closed.error,
            "decompile_all",
          ),
        );
  }

  async close(): Promise<Result<void, AnalysisError>> {
    try {
      await this.#cleanup.release();
      return ok(undefined);
    } catch (cause: unknown) {
      const error = new AnalysisOutputError(
        "decompile_all",
        "decompile export cleanup failed",
        {
          cause,
          cleanup: {
            reason: "Owned export resources could not be released.",
            resources: [this.root],
          },
        },
      );
      error.bindCleanupResourceOwner(this.#cleanup);
      this.#cleanup.bindCleanupError(error);
      if (!this.#retained && this.scope !== undefined) {
        this.#retained = true;
        const cleanup = this.#cleanup;
        this.scope.retain(
          {
            close: () => cleanup.release(),
            get cleanupResources() {
              return cleanup.cleanupResources;
            },
          },
          this.root,
        );
      }
      return err(error);
    }
  }

  async #removeCreatedRoot(): Promise<void> {
    const root = await lstat(this.root, { bigint: true });
    if (
      !sameIdentity(root, this.identity) ||
      !root.isDirectory() ||
      root.isSymbolicLink()
    )
      throw new Error("Export directory identity changed during cleanup");
    // Initialization has not exported functions. Refuse unexpected entries rather
    // than recursively deleting work introduced by another owner.
    if (!this.#journalRemoved) {
      const journal = join(this.root, DECOMPILE_DIRECTORY_JOURNAL_NAME);
      const stat = await lstat(journal, { bigint: true }).catch(
        (cause: unknown) => {
          if (isMissing(cause)) return undefined;
          throw cause;
        },
      );
      if (stat !== undefined) {
        if (
          this.#journalIdentity === undefined ||
          !sameIdentity(stat, this.#journalIdentity)
        )
          throw new Error(
            "Cannot establish ownership of the journal during cleanup",
          );
        await unlink(journal);
      }
      this.#journalRemoved = true;
    }
    if (!this.#functionsRemoved) {
      const path = join(this.root, "functions");
      const stat = await lstat(path, { bigint: true }).catch(
        (cause: unknown) => {
          if (isMissing(cause) && this.#functionsIdentity === undefined)
            return undefined;
          throw cause;
        },
      );
      if (stat !== undefined) {
        if (
          this.#functionsIdentity === undefined ||
          !sameIdentity(stat, this.#functionsIdentity)
        )
          throw new Error(
            "Functions directory identity changed during cleanup",
          );
        await rmdir(path);
      }
      this.#functionsRemoved = true;
    }
    await rmdir(this.root);
    this.#rootRemoved = true;
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
