import { appendCallerPath } from "../filesystem/callerPath.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { cancelledBy, isAborted } from "../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { Deadline } from "../domain/deadline.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisCleanupRelease } from "../domain/analysisCleanupRelease.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  type ArtifactResourceScope,
  withArtifactFileHandle,
  withArtifactRegularFile,
  assertArtifactReadActive,
  artifactFilePrimaryFacts,
  mapArtifactFileFailure,
} from "../resources/index.js";
import {
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import {
  acquireOwnedLease,
  LEASE_OWNER_PROBE_ABORTED,
  LEASE_OWNER_RESPONSE_TIMEOUT_MS,
  LEASE_OWNER_RESPONSE_TIMED_OUT,
  type LeaseAcquisition,
  type OwnedLease,
} from "../process/OwnedLease.js";
import {
  DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT,
  GHIDRA_CHECKPOINT_SAVE_POLL_MS,
  ghidraCheckpointSaveWaitFacts,
  type GhidraCheckpointSaveWait,
} from "../config/ghidraCheckpointSaveWait.js";
import {
  copyGhidraRegularFile,
  ghidraFileDialect,
  readGhidraProfileArtifact,
} from "./GhidraFileArtifacts.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z
  .object({
    file: z.string().regex(/^program-[a-f0-9-]{36}\.gzf$/),
    sha256: digest,
    kind: z.enum(["initial-analysis", "retained"]),
  })
  .strict();
type CheckpointSource = z.infer<typeof sourceSchema>;
const manifestSchema = z
  .object({
    version: z.literal(2),
    target_sha256: digest,
    base_profile_digest: digest,
    source: sourceSchema,
  })
  .strict();
const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initial-analysis") }).strict(),
  z.object({ kind: z.literal("retained"), sha256: digest }).strict(),
]);
const checkpointState = (
  source: CheckpointSource | null,
): z.infer<typeof stateSchema> =>
  source === null || source.kind === "initial-analysis"
    ? { kind: "initial-analysis" }
    : { kind: "retained", sha256: source.sha256 };

/** Semantic generation is stable through the first save; edited states bind their digest. */
export const ghidraCheckpointSelectionSchema = z
  .object({
    directory: z.string().min(1),
    key: digest,
    target_sha256: digest,
    base_profile_digest: digest,
    state: stateSchema,
  })
  .strict();
export type GhidraCheckpointSelection = z.infer<
  typeof ghidraCheckpointSelectionSchema
>;
export interface GhidraPackedProgram {
  readonly path: string;
  readonly sha256: string;
}

const missing = (cause: unknown): boolean => {
  const primary = artifactFilePrimaryFacts(cause).cause;
  return (
    primary instanceof Error && "code" in primary && primary.code === "ENOENT"
  );
};
const failure = (directory: string, reason: string, cause?: unknown) =>
  new ConfigurationError(
    `Ghidra checkpoint at ${JSON.stringify(directory)}: ${reason}. Preserve this directory; correct its contents or select a new REA_GHIDRA_CHECKPOINT_DIR, then reopen the target.`,
    {
      cause,
      settings: [{ setting: "REA_GHIDRA_CHECKPOINT_DIR", constraint: reason }],
    },
  );

/**
 * Another live REA session held this checkpoint's publication lease for the
 * whole bounded wait. The directory and its setting are valid, so this is
 * contention that ends when that publication finishes, not a configuration
 * fault. `wait` is the bound this session applied.
 */
export class GhidraCheckpointBusyError extends Error {
  /** Cleanup that also failed after the refusal; the refusal stays primary. */
  cleanupFailure: AnalysisError | undefined;
  constructor(
    readonly directory: string,
    readonly owner:
      | { readonly runId: string; readonly processId: number }
      | undefined,
    readonly wait: GhidraCheckpointSaveWait,
  ) {
    const holder =
      owner === undefined
        ? "another REA session"
        : `another REA session (run ${owner.runId}, process ${String(owner.processId)})`;
    super(
      `Ghidra checkpoint at ${JSON.stringify(directory)} is being saved by ${holder}, and that save did not finish within this session's save wait: ${ghidraCheckpointSaveWaitFacts(wait)}`,
    );
    this.name = "GhidraCheckpointBusyError";
  }
}

/**
 * The checkpoint no longer holds the generation this session selected or
 * restored. Nothing was published and the current checkpoint is unchanged:
 * a restore must reopen the target, and a save was refused instead of
 * overwriting the newer generation.
 */
export class GhidraCheckpointSupersededError extends Error {
  /** Cleanup that also failed after the refusal; the refusal stays primary. */
  cleanupFailure: AnalysisError | undefined;
  /**
   * Whether the session holds Program edits this refusal kept from being
   * saved. Only a save refuses edits: a restore, including a session whose
   * initial analysis was overtaken, has none and simply reopens.
   */
  readonly refusesEdits: boolean;
  constructor(
    readonly directory: string,
    readonly stage: "restore" | "save",
  ) {
    super(
      stage === "restore"
        ? `Ghidra checkpoint at ${JSON.stringify(directory)} changed after this session selected it, normally because another REA session saved Program edits; reopen the target to restore the current checkpoint`
        : `Ghidra checkpoint at ${JSON.stringify(directory)} changed after this session restored it, normally because another REA session saved Program edits first; this session's Program edits were not saved and the current checkpoint is unchanged. Closing the target again discards them; reopen the target and reapply them to the current checkpoint`,
    );
    this.name = "GhidraCheckpointSupersededError";
    this.refusesEdits = stage === "save";
  }
}

/** Hash large packed Programs with one 64 KiB buffer and stable descriptor identity. */
export const hashGhidraPackedProgram = (
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string> =>
  withArtifactRegularFile(
    path,
    resources,
    signal,
    async ({ handle, initial }) => {
      const hash = createHash("sha256"),
        buffer = Buffer.allocUnsafe(64 * 1024);
      for (let offset = 0; offset < initial.size;) {
        assertArtifactReadActive(signal);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, initial.size - offset),
          offset,
        );
        if (bytesRead === 0) throw new RegularFileChangedError(path);
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (!sameRegularFileState(initial, await handle.stat()))
        throw new RegularFileChangedError(path);
      return hash.digest("hex");
    },
  );

type CheckpointSelectionKey = Omit<GhidraCheckpointSelection, "state">;

async function readManifest(
  selection: CheckpointSelectionKey,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<CheckpointSource | null> {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = await readGhidraProfileArtifact(
      appendCallerPath(selection.directory, "current.json"),
      64 * 1024,
      resources,
      signal,
      (bytes) => manifestSchema.parse(JSON.parse(bytes.toString("utf8"))),
    );
  } catch (cause: unknown) {
    if (missing(cause) && !resources.hasPending) return null;
    throw classifyProviderFailure(
      mapArtifactFileFailure(cause, (primary) =>
        primary instanceof SyntaxError || primary instanceof z.ZodError
          ? failure(selection.directory, "the manifest is malformed", primary)
          : primary,
      ),
      ghidraFileDialect("resolve_analysis_profile", {
        path: appendCallerPath(selection.directory, "current.json"),
      }),
    );
  }
  if (
    manifest.target_sha256 !== selection.target_sha256 ||
    manifest.base_profile_digest !== selection.base_profile_digest
  )
    throw failure(
      selection.directory,
      "the manifest belongs to a different target or analysis profile",
    );
  return manifest.source;
}

async function readVerifiedSource(
  selection: CheckpointSelectionKey,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<CheckpointSource | null> {
  const source = await readManifest(selection, resources, signal);
  if (source === null) return null;
  const path = appendCallerPath(selection.directory, source.file);
  let actual: string;
  try {
    actual = await hashGhidraPackedProgram(path, resources, signal);
  } catch (cause: unknown) {
    throw classifyProviderFailure(
      cause,
      ghidraFileDialect("resolve_analysis_profile", { path }),
    );
  }
  if (actual !== source.sha256)
    throw failure(
      selection.directory,
      "the packed Program checksum differs from its manifest",
    );
  return source;
}

/** A publication renames a new manifest file into place, so its identity changes. */
const manifestIdentity = async (directory: string): Promise<string | null> => {
  try {
    const state = await lstat(appendCallerPath(directory, "current.json"), {
      bigint: true,
    });
    return `${String(state.dev)}:${String(state.ino)}`;
  } catch {
    return null;
  }
};

/**
 * Readers hold no lease. A publication replaces the manifest and then removes
 * the packed file it superseded, so a read that straddles one can find the
 * replaced manifest or the removed file. Only a read during which the manifest
 * was replaced is repeated; any other failure is reported as it is.
 */
async function readSource(
  selection: CheckpointSelectionKey,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<CheckpointSource | null> {
  for (let attempt = 0; ; attempt += 1) {
    const before = await manifestIdentity(selection.directory);
    try {
      return await readVerifiedSource(selection, resources, signal);
    } catch (cause: unknown) {
      if (
        attempt === 2 ||
        signal?.aborted === true ||
        resources.hasPending ||
        (await manifestIdentity(selection.directory)) === before
      )
        throw cause;
    }
  }
}

const sameSource = (
  left: CheckpointSource | null,
  right: CheckpointSource | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.file === right.file && left.sha256 === right.sha256;

/** Resolve storage and content identity once for the shared CLI/MCP analysis profile. */
export async function resolveGhidraCheckpoint(
  root: string,
  targetSha256: string,
  profile: AnalysisProfileCommitment,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraCheckpointSelection> {
  const key = sha256Hex(JSON.stringify([targetSha256, profile.digest]));
  const selection = {
    directory: appendCallerPath(root, key),
    key,
    target_sha256: targetSha256,
    base_profile_digest: profile.digest,
  };
  return {
    ...selection,
    state: checkpointState(await readSource(selection, resources, signal)),
  };
}

/**
 * One session's view of a shared checkpoint. Sessions restore the packed
 * Program into private projects without a lease; the socket lease is held only
 * while one of them publishes. Publication is a compare-and-set on the source
 * this session started from, so a session never overwrites a generation it did
 * not restore. The session owns its lease and any failed staging cleanup.
 */
export class GhidraCheckpoint {
  #lease: OwnedLease | undefined;
  /** Physical directory and lease owner of the admitted session. */
  #admission:
    | { readonly directory: string; readonly runId: string }
    | undefined;
  /** The source this session's Program derives from; null before any publication. */
  #source: CheckpointSource | null | undefined;
  #state: GhidraCheckpointSelection["state"];
  readonly #pendingRemoval = new Set<string>();
  /** Reported by every removal failure until a retry removes every file. */
  #cleanupRelease = new AnalysisCleanupRelease();
  #publishedInput: string | undefined;
  constructor(
    readonly selection: GhidraCheckpointSelection,
    private readonly resources: ArtifactResourceScope,
    /** Bound on waiting for another session's publication, fixed for this session. */
    private readonly saveWait: GhidraCheckpointSaveWait = DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT,
  ) {
    this.#state = selection.state;
  }
  get hasResources(): boolean {
    return this.#lease !== undefined || this.#pendingRemoval.size > 0;
  }
  get cleanupResources(): readonly string[] {
    return [
      ...(this.#lease === undefined
        ? []
        : [this.#lease.socketPath ?? this.selection.directory]),
      ...this.#pendingRemoval,
    ];
  }
  get observation() {
    return {
      directory: this.selection.directory,
      source: this.#source ?? null,
      source_verified: this.#source !== undefined,
      state: this.#state,
      pending_cleanup: [...this.#pendingRemoval],
    };
  }

  /** Verify the selected generation and return its packed Program, if one exists. */
  async admit(
    runId: string,
    signal?: AbortSignal,
  ): Promise<GhidraPackedProgram | undefined> {
    assertArtifactReadActive(signal);
    await mkdir(this.selection.directory, { recursive: true, mode: 0o700 });
    const state = await lstat(this.selection.directory);
    if (
      !state.isDirectory() ||
      (state.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && state.uid !== process.getuid())
    )
      throw failure(
        this.selection.directory,
        "the checkpoint directory must be a private directory owned by this user",
      );
    const directory = await realpath(this.selection.directory);
    this.#admission = undefined;
    this.#source = undefined;
    const current = await readSource(this.selection, this.resources, signal);
    const generation = checkpointState(current);
    const aligned =
      generation.kind === "initial-analysis"
        ? this.#state.kind === "initial-analysis"
        : this.#state.kind === "retained" &&
          this.#state.sha256 === generation.sha256;
    if (!aligned)
      throw new GhidraCheckpointSupersededError(directory, "restore");
    assertArtifactReadActive(signal);
    this.#admission = { directory, runId };
    this.#source = current;
    return current === null
      ? undefined
      : { path: join(directory, current.file), sha256: current.sha256 };
  }

  /**
   * Explain a failed private restore: a publication after admission removes
   * the packed file this session was about to copy.
   */
  async supersededRestore(
    signal?: AbortSignal,
  ): Promise<GhidraCheckpointSupersededError | undefined> {
    if (this.#admission === undefined || this.#source === undefined)
      return undefined;
    const current = await readManifest(this.selection, this.resources, signal);
    return sameSource(current, this.#source)
      ? undefined
      : new GhidraCheckpointSupersededError(
          this.#admission.directory,
          "restore",
        );
  }

  /** Wait a bounded time for another session's publication to finish. */
  async #acquireLease(
    admission: { readonly directory: string; readonly runId: string },
    signal?: AbortSignal,
  ): Promise<OwnedLease> {
    const deadline = Deadline.after(this.saveWait.waitMs);
    // An owner that releases while a probe reads its identity, or another
    // waiter recovering the released socket, ends within the wait; any other
    // lease failure, or one that outlasts the wait, is reported unchanged.
    // The owner-identity probe itself stops at the remaining wait or when
    // this save is cancelled. A probe cut off by that wait is the busy
    // refusal: the socket was accepted and no identity arrived in time.
    const handoff = new WeakSet<Error>();
    const probeTimedOut = new WeakSet<Error>();
    const probeAborted = new WeakSet<Error>();
    let heldBy:
      | { readonly runId: string; readonly processId: number }
      | undefined;
    // A handoff that is still inside the wait. If the wait ends before the
    // next probe, or that probe acquires only after the wait, this failure
    // is the result: publication does not start.
    let handoffFailure: Error | undefined;
    for (;;) {
      assertArtifactReadActive(signal);
      let acquired: LeaseAcquisition | undefined;
      try {
        acquired = await acquireOwnedLease({
          identity: {
            kind: "ghidra-checkpoint-v1",
            directory: admission.directory,
          },
          runId: admission.runId,
          directory: join(
            "/tmp",
            `rea-ghidra-checkpoint-leases-${process.getuid?.() ?? "user"}`,
          ),
          resources: this.resources,
          probe: {
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: Math.min(
              LEASE_OWNER_RESPONSE_TIMEOUT_MS,
              deadline.remainingMs(),
            ),
          },
          failure: (reason, cause) => {
            const error = failure(
              admission.directory,
              `lease ${reason.kind}${cause instanceof Error ? `: ${cause.message}` : ""}`,
              cause,
            );
            if (
              reason.kind === "owner_unverified" ||
              reason.kind === "recovery_busy"
            )
              handoff.add(error);
            if (
              reason.kind === "owner_unverified" &&
              reason.reason === LEASE_OWNER_RESPONSE_TIMED_OUT
            )
              probeTimedOut.add(error);
            if (
              reason.kind === "owner_unverified" &&
              reason.reason === LEASE_OWNER_PROBE_ABORTED
            )
              probeAborted.add(error);
            return error;
          },
        });
      } catch (cause: unknown) {
        // A probe this wait aborted has no cleanup of its own. Any other
        // acquisition failure, including a directory handle whose close
        // failed, stays primary and keeps the cancellation beside it.
        if (
          isAborted(signal) &&
          !(cause instanceof Error && probeAborted.has(cause)) &&
          cause instanceof AnalysisError
        )
          throw analysisErrorWithCancellation(
            cause,
            cancelledBy("checkpoint_program", signal),
          );
        if (isAborted(signal)) assertArtifactReadActive(signal);
        if (
          cause instanceof Error &&
          probeTimedOut.has(cause) &&
          deadline.expired()
        )
          throw new GhidraCheckpointBusyError(
            admission.directory,
            undefined,
            this.saveWait,
          );
        if (
          !(cause instanceof Error && handoff.has(cause)) ||
          deadline.expired()
        )
          throw cause;
        handoffFailure = cause;
      }
      if (acquired?.acquired === true) {
        // The wait bounds contention already observed: a holder, or a
        // handoff that has not settled. An uncontended acquire that
        // finishes late is this session's own overhead, so publication
        // still proceeds. A late acquire after contention keeps the lease
        // for cleanup and does not publish.
        if (deadline.expired() && heldBy !== undefined) {
          this.#lease = acquired.lease;
          throw new GhidraCheckpointBusyError(
            admission.directory,
            heldBy,
            this.saveWait,
          );
        }
        if (deadline.expired() && handoffFailure !== undefined) {
          this.#lease = acquired.lease;
          throw handoffFailure;
        }
        return acquired.lease;
      }
      const sawHolder = acquired !== undefined;
      if (acquired !== undefined) {
        heldBy = acquired.owner;
        if (deadline.expired())
          throw new GhidraCheckpointBusyError(
            admission.directory,
            acquired.owner,
            this.saveWait,
          );
      }
      await delay(GHIDRA_CHECKPOINT_SAVE_POLL_MS, undefined, { signal }).catch(
        () => undefined,
      );
      // The poll callback can run after the wait when the event loop stalls.
      // Contention already observed for this poll used the whole wait, so
      // do not probe again. A holder becomes the busy refusal. A handoff
      // that outlasts the wait is reported unchanged.
      assertArtifactReadActive(signal);
      if (!deadline.expired()) continue;
      if (sawHolder)
        throw new GhidraCheckpointBusyError(
          admission.directory,
          heldBy,
          this.saveWait,
        );
      if (handoffFailure !== undefined) throw handoffFailure;
    }
  }

  /**
   * Publish a new immutable blob, then atomically replace its manifest, only
   * while the checkpoint still holds the source this session started from.
   * Two sessions that both analyzed a target without a checkpoint hold the
   * same initial generation, so the later one adopts the published Program
   * instead of publishing a second copy.
   */
  /**
   * `leaseSignal` ends only the wait for another session's publication, which
   * is this save's cancellation cutoff; once the lease is held, publication
   * observes `signal` alone, so a close's save completes the bounded copy.
   */
  async publish(
    path: string,
    signal?: AbortSignal,
    leaseSignal: AbortSignal | undefined = signal,
  ): Promise<void> {
    const admission = this.#admission;
    if (admission === undefined || this.#source === undefined)
      throw failure(
        this.selection.directory,
        "publication has no admitted session",
      );
    const previous = this.#source;
    await this.retryCleanup();
    if (this.#publishedInput === path) return;
    const classify = (cause: unknown) =>
      classifyProviderFailure(
        cause,
        ghidraFileDialect("checkpoint_program", {
          path: this.selection.directory,
        }),
      );
    let primary: unknown;
    let failed = false;
    try {
      this.#lease = await this.#acquireLease(admission, leaseSignal);
      // Acquiring the lease is the cancellation cutoff: an abort that arrived
      // during acquisition stops before publication, and the cleanup below
      // releases the lease. Once past here the bounded publication completes.
      assertArtifactReadActive(leaseSignal);
      const current = await readManifest(
        this.selection,
        this.resources,
        signal,
      );
      if (
        previous === null &&
        current !== null &&
        current.kind === "initial-analysis"
      ) {
        this.#source = current;
        this.#publishedInput = path;
      } else if (sameSource(current, previous))
        await this.#replace(path, previous, signal);
      // A session that never published holds only its initial analysis and no
      // edits, so it is a superseded selection that a reopen restores.
      else
        throw new GhidraCheckpointSupersededError(
          admission.directory,
          previous === null ? "restore" : "save",
        );
    } catch (cause: unknown) {
      primary = cause;
      failed = true;
    }
    try {
      await this.retryCleanup();
    } catch (cause: unknown) {
      if (!failed) throw cause;
      // A refusal is the owner's typed outcome: keep it primary, unwrapped,
      // so its consumers still read it, and carry the cleanup failure on it.
      if (
        primary instanceof GhidraCheckpointSupersededError ||
        primary instanceof GhidraCheckpointBusyError
      ) {
        primary.cleanupFailure ??= classify(cause);
        throw primary;
      }
      throw analysisErrorWithCleanupFailure(classify(primary), classify(cause));
    }
    if (failed)
      throw primary instanceof GhidraCheckpointSupersededError ||
        primary instanceof GhidraCheckpointBusyError
        ? primary
        : classify(primary);
    assertArtifactReadActive(signal);
  }

  /** Runs under the publication lease after the compare-and-set admitted it. */
  async #replace(
    path: string,
    previous: CheckpointSource | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = `program-${randomUUID()}.gzf`;
    const destination = appendCallerPath(this.selection.directory, file);
    const temporary = appendCallerPath(
      this.selection.directory,
      `.current-${randomUUID()}.json`,
    );
    this.#pendingRemoval.add(destination);
    this.#pendingRemoval.add(temporary);
    assertArtifactReadActive(signal);
    const hash = createHash("sha256");
    await copyGhidraRegularFile(path, destination, this.resources, {
      signal,
      hash,
      sync: true,
    });
    const source: CheckpointSource = {
      file,
      sha256: hash.digest("hex"),
      kind: previous === null ? "initial-analysis" : "retained",
    };
    const metadata = JSON.stringify({
      version: 2,
      target_sha256: this.selection.target_sha256,
      base_profile_digest: this.selection.base_profile_digest,
      source,
    });
    const handle = await open(temporary, "wx", 0o600);
    await withArtifactFileHandle(
      temporary,
      handle,
      this.resources,
      signal,
      async (handle) => {
        await handle.writeFile(metadata);
        await handle.sync();
      },
    );
    assertArtifactReadActive(signal);
    await rename(
      temporary,
      appendCallerPath(this.selection.directory, "current.json"),
    );
    this.#source = source;
    this.#state = checkpointState(source);
    this.#publishedInput = path;
    this.#pendingRemoval.delete(destination);
    this.#pendingRemoval.delete(temporary);
    if (previous !== null)
      this.#pendingRemoval.add(
        appendCallerPath(this.selection.directory, previous.file),
      );
  }

  /**
   * Remove owned staging and superseded files and release the publication
   * lease. The manifest names none of these files and the lease serializes
   * only publication, so a failed removal is retained without holding the
   * lease that other sessions' saves wait on.
   */
  async retryCleanup(): Promise<void> {
    let removal: unknown;
    for (const path of this.#pendingRemoval) {
      try {
        await rm(path, { force: true });
        this.#pendingRemoval.delete(path);
      } catch (cause: unknown) {
        removal = cause;
        break;
      }
    }
    let release: { readonly cause: unknown } | undefined;
    try {
      await this.#lease?.release();
      this.#lease = undefined;
    } catch (cause: unknown) {
      // The lease stays owned for retry; a lone release failure keeps its
      // own error, and one alongside a removal failure is reported with it.
      if (removal === undefined) throw cause;
      release = { cause };
    }
    if (removal !== undefined) {
      const error = new ProviderCleanupError(
        "ghidra",
        this.cleanupResources,
        {
          reason:
            release === undefined
              ? `Checkpoint file cleanup failed: ${errorMessage(removal)}`
              : `Checkpoint file cleanup failed: ${errorMessage(removal)}; releasing the checkpoint lease also failed: ${errorMessage(release.cause)}`,
          checkpoint: this.observation,
        },
        {
          cause:
            release === undefined
              ? removal
              : new AggregateError(
                  [removal, release.cause],
                  "Checkpoint file removal and lease release failed",
                ),
        },
      );
      throw this.#cleanupRelease.bind(error);
    }
    this.#cleanupRelease.confirm();
    this.#cleanupRelease = new AnalysisCleanupRelease();
  }
}
