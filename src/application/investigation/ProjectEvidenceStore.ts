import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import canonicalize from "canonicalize";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { safeParseImmutableEvidence } from "../../domain/evidenceValidation.js";
import { err, ok, type Result } from "../../domain/result.js";

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/u;

/** One stored record is a single Evidence object, so an oversized name is not a record. */
const MAX_STORED_RECORD_BYTES = 64 * 1024 * 1024;

/** Complete dossiers are large; retained reads stay bounded until the session closes. */
const MAX_CACHED_RECORDS = 32;

/** A durable-write attempt that failed, with any temporary file this store still owns. */
interface WriteAttemptFailure {
  readonly cause: unknown;
  readonly retainedTemporary: string | undefined;
  readonly cleanupCause: unknown;
}

/** Project-local content-addressed Evidence storage under `.rea/evidence`. */
export class ProjectEvidenceStore {
  readonly #recordsDirectory: string;
  readonly #cache = new Map<string, Evidence>();
  readonly #queued = new Map<string, Evidence>();
  readonly #pending = new Set<Promise<void>>();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#recordsDirectory = join(root, "records");
  }

  /**
   * Schedule one authenticated record. A record named again keeps its newest
   * metadata in the queue, so a relocated import can still replace an earlier
   * write that has not committed yet.
   */
  persist(evidence: Evidence): void {
    const id = evidence.evidence_id;
    if (!EVIDENCE_ID.test(id)) return;
    this.#queued.set(id, evidence);
    // One drain at a time; a record queued during an attempt is picked up by
    // the next persist or by the close-time flush.
    if (this.#pending.size > 0) return;
    const write: Promise<void> = this.#writeChain.then(async () => {
      await this.#attemptQueuedWrites();
    });
    this.#writeChain = write.catch(() => undefined);
    const pending = write.catch(() => undefined);
    this.#pending.add(pending);
    void pending.finally(() => {
      this.#pending.delete(pending);
    });
  }

  /** Return one stored record after authenticating its content and ID. */
  read(evidenceId: string): Evidence | undefined {
    if (!EVIDENCE_ID.test(evidenceId)) return undefined;
    const cached = this.#cache.get(evidenceId);
    if (cached !== undefined) {
      // Re-insert so the ceiling evicts the least recently read record.
      this.#cache.delete(evidenceId);
      this.#cache.set(evidenceId, cached);
      return cached;
    }
    const text = this.#readRegularFile(
      join(this.#recordsDirectory, `${evidenceId}.json`),
    );
    if (text === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    const parsed = safeParseImmutableEvidence(value);
    if (!parsed.ok || parsed.value.evidence_id !== evidenceId) return undefined;
    this.#cache.set(evidenceId, parsed.value);
    while (this.#cache.size > MAX_CACHED_RECORDS) {
      const oldest = this.#cache.keys().next();
      if (oldest.done === true) break;
      this.#cache.delete(oldest.value);
    }
    return parsed.value;
  }

  /** Report presence only when the stored record authenticates. */
  has(evidenceId: string): boolean {
    return this.read(evidenceId) !== undefined;
  }

  /**
   * Wait for scheduled writes and attempt whatever is still queued once more.
   * A record whose write failed stays queued, so a later close retries it after
   * the storage problem is fixed instead of reporting the same stale failure.
   */
  async flush(): Promise<Result<null, AnalysisError>> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
    const failure = await this.#attemptQueuedWrites();
    return failure === undefined ? ok(null) : err(this.#failureOf(failure));
  }

  /** Release retained reads; a later session authenticates from disk again. */
  releaseCachedReads(): void {
    this.#cache.clear();
  }

  /** Attempt every still-queued record once; committed records leave the queue. */
  async #attemptQueuedWrites(): Promise<WriteAttemptFailure | undefined> {
    let failure: WriteAttemptFailure | undefined;
    // Live iteration also picks up records queued during an earlier attempt.
    for (const evidence of this.#queued.values()) {
      const wrote = await this.#write(evidence);
      if (!wrote.ok) {
        failure ??= wrote.error;
        continue;
      }
      this.#queued.delete(evidence.evidence_id);
      // A replacement must not keep serving the metadata the previous write held.
      this.#cache.delete(evidence.evidence_id);
    }
    return failure;
  }

  #failureOf(failure: WriteAttemptFailure): AnalysisError {
    const cause =
      failure.cause instanceof Error
        ? failure.cause
        : new Error(String(failure.cause));
    if (failure.retainedTemporary === undefined)
      return this.#unavailable(cause, cause.message);
    const cleanup =
      failure.cleanupCause instanceof Error
        ? failure.cleanupCause.message
        : String(failure.cleanupCause);
    const retained = new Error(
      `A temporary store file remains at ${failure.retainedTemporary}: ${cleanup}`,
    );
    return this.#unavailable(
      new AggregateError([cause, retained], "Durable write failed"),
      `${cause.message} ${retained.message}`,
    );
  }

  #unavailable(cause: Error, detail: string): AnalysisError {
    return new AnalysisCapabilityUnavailableError(
      "rea-evidence-store",
      "persist",
      `Project Evidence could not be written: ${detail}`,
      {
        cause,
        userMessage:
          "REA could not persist Evidence to the project store. Inspect the configured store directory permissions and available space before relying on cross-session reuse.",
      },
    );
  }

  /**
   * Read only a regular file of plausible record size. A FIFO at an expected
   * name cannot block the server, and an oversized file cannot be allocated.
   */
  #readRegularFile(path: string): string | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const status = fstatSync(fd);
      if (!status.isFile() || status.size > MAX_STORED_RECORD_BYTES)
        return undefined;
      const bytes = new Uint8Array(status.size);
      let filled = 0;
      while (filled < bytes.length) {
        const step = readSync(fd, bytes, filled, bytes.length - filled, filled);
        if (step === 0) break;
        filled += step;
      }
      return Buffer.from(bytes.subarray(0, filled)).toString("utf8");
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeQuietly(fd);
    }
  }

  /** Write and sync the record before renaming; retain a temporary that survives. */
  async #write(evidence: Evidence): Promise<Result<null, WriteAttemptFailure>> {
    const path = join(this.#recordsDirectory, `${evidence.evidence_id}.json`);
    const temporary = join(
      this.#recordsDirectory,
      `.${evidence.evidence_id}.${process.pid}.${randomUUID()}.tmp`,
    );
    const encoded = `${canonicalize(evidence) ?? JSON.stringify(evidence)}\n`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    // A temporary exists only after its open succeeded and until the rename lands.
    let staged = false;
    try {
      // Directory admission fails the same way a write does; it is not an escape.
      await mkdir(this.#recordsDirectory, { recursive: true, mode: 0o700 });
      file = await open(temporary, "wx", 0o600);
      staged = true;
      await file.writeFile(encoded);
      // A rename alone does not make the bytes durable across a host crash.
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, path);
      staged = false;
      await this.#syncRecordsDirectory();
      return ok(null);
    } catch (cause: unknown) {
      if (file !== undefined) await file.close().catch(() => undefined);
      if (!staged) return err(singleFailure(cause, undefined, undefined));
      const cleanupCause = await rm(temporary, { force: true }).then(
        () => undefined,
        (cleanup: unknown) => cleanup,
      );
      return err(
        singleFailure(
          cause,
          cleanupCause === undefined ? undefined : temporary,
          cleanupCause,
        ),
      );
    }
  }

  /** Directory durability is platform-dependent; only supported platforms sync it. */
  async #syncRecordsDirectory(): Promise<void> {
    let directory: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directory = await open(this.#recordsDirectory, "r");
      await directory.sync();
    } catch (cause: unknown) {
      // EINVAL/EBADF/ENOTSUP/ENOSYS/EPERM mean this platform cannot sync a directory.
      const code = (cause as { code?: string }).code;
      if (
        code !== "EINVAL" &&
        code !== "EBADF" &&
        code !== "ENOTSUP" &&
        code !== "ENOSYS" &&
        code !== "EPERM"
      )
        throw cause;
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }
}

const singleFailure = (
  cause: unknown,
  retainedTemporary: string | undefined,
  cleanupCause: unknown,
): WriteAttemptFailure => ({ cause, retainedTemporary, cleanupCause });

const closeQuietly = (fd: number): void => {
  try {
    closeSync(fd);
  } catch {
    // A descriptor that will not close cannot undo a completed read.
  }
};
