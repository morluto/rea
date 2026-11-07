import { appendCallerPath } from "../filesystem/callerPath.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  withArtifactFileHandle,
  withArtifactRegularFile,
  assertArtifactReadActive,
  artifactFilePrimaryFacts,
} from "../artifacts/ArtifactFileOperation.js";
import {
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { acquireOwnedLease, type OwnedLease } from "../process/OwnedLease.js";
import {
  ghidraFileFailure,
  readGhidraProfileArtifact,
} from "./GhidraFileArtifacts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z
  .object({
    file: z.string().regex(/^program-[a-f0-9-]{36}\.gzf$/),
    sha256: digest,
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    target_sha256: digest,
    base_profile_digest: digest,
    source: sourceSchema,
  })
  .strict();
/** Exact saved state committed before opening a Program; null requests a fresh import. */
export const ghidraCheckpointSelectionSchema = z
  .object({
    directory: z.string().min(1),
    key: digest,
    target_sha256: digest,
    base_profile_digest: digest,
    source: sourceSchema.nullable(),
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

async function readSource(
  selection: Omit<GhidraCheckpointSelection, "source">,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) {
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
    throw failure(
      selection.directory,
      "the manifest is unreadable or malformed",
      cause,
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
  const path = appendCallerPath(selection.directory, manifest.source.file);
  let actual: string;
  try {
    actual = await hashGhidraPackedProgram(path, resources, signal);
  } catch (cause: unknown) {
    throw failure(
      selection.directory,
      "the packed Program cannot be verified",
      cause,
    );
  }
  if (actual !== manifest.source.sha256)
    throw failure(
      selection.directory,
      "the packed Program checksum differs from its manifest",
    );
  return manifest.source;
}

/** Resolve storage and content identity once for the shared CLI/MCP analysis profile. */
export async function resolveGhidraCheckpoint(
  root: string,
  targetSha256: string,
  profile: AnalysisProfileCommitment,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraCheckpointSelection> {
  const key = createHash("sha256")
    .update(JSON.stringify([targetSha256, profile.digest]))
    .digest("hex");
  const selection = {
    directory: appendCallerPath(root, key),
    key,
    target_sha256: targetSha256,
    base_profile_digest: profile.digest,
  };
  return {
    ...selection,
    source: await readSource(selection, resources, signal),
  };
}

/** One session owns publication, the socket lease, and any failed staging cleanup. */
export class GhidraCheckpoint {
  #lease: OwnedLease | undefined;
  #source: GhidraCheckpointSelection["source"];
  readonly #pendingRemoval = new Set<string>();
  readonly #cleanupFailures = new Set<ProviderCleanupError>();
  #publishedInput: string | undefined;
  constructor(
    readonly selection: GhidraCheckpointSelection,
    private readonly resources: ArtifactResourceScope,
  ) {
    this.#source = selection.source;
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
      source: this.#source,
      pending_cleanup: [...this.#pendingRemoval],
    };
  }

  async acquire(
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
    const acquired = await acquireOwnedLease({
      identity: { kind: "ghidra-checkpoint-v1", directory },
      runId,
      directory: join(
        "/tmp",
        `rea-ghidra-checkpoint-leases-${process.getuid?.() ?? "user"}`,
      ),
      resources: this.resources,
      failure: (reason, cause) =>
        failure(
          directory,
          `lease ${reason.kind}${cause instanceof Error ? `: ${cause.message}` : ""}`,
          cause,
        ),
    });
    if (!acquired.acquired)
      throw failure(
        directory,
        `another REA session owns this checkpoint (run ${acquired.owner.runId}, process ${acquired.owner.processId}); close that session before retrying`,
      );
    this.#lease = acquired.lease;
    const current = await readSource(this.selection, this.resources, signal);
    if (JSON.stringify(current) !== JSON.stringify(this.#source))
      throw failure(
        directory,
        "the checkpoint changed after profile selection; reopen the target",
      );
    assertArtifactReadActive(signal);
    return current === null
      ? undefined
      : { path: join(directory, current.file), sha256: current.sha256 };
  }

  /** Publish a new immutable blob, then atomically replace its manifest. */
  async publish(path: string, signal?: AbortSignal): Promise<void> {
    if (this.#lease === undefined)
      throw failure(
        this.selection.directory,
        "publication has no owning session lease",
      );
    await this.retryCleanup();
    if (this.#publishedInput === path) return;
    const file = `program-${randomUUID()}.gzf`;
    const destination = appendCallerPath(this.selection.directory, file);
    const temporary = appendCallerPath(
      this.selection.directory,
      `.current-${randomUUID()}.json`,
    );
    this.#pendingRemoval.add(destination);
    this.#pendingRemoval.add(temporary);
    let primary: unknown;
    let failed = false;
    try {
      assertArtifactReadActive(signal);
      await copyFile(path, destination, constants.COPYFILE_EXCL);
      const sha256 = await hashGhidraPackedProgram(
        destination,
        this.resources,
        signal,
      );
      const source = { file, sha256 };
      for (const [output, bytes] of [
        [destination, undefined],
        [
          temporary,
          JSON.stringify({
            version: 1,
            target_sha256: this.selection.target_sha256,
            base_profile_digest: this.selection.base_profile_digest,
            source,
          }),
        ],
      ] as const) {
        const handle = await open(
          output,
          bytes === undefined ? "r+" : "wx",
          0o600,
        );
        await withArtifactFileHandle(
          output,
          handle,
          this.resources,
          signal,
          async (handle) => {
            if (bytes !== undefined) await handle.writeFile(bytes);
            await handle.sync();
          },
        );
      }
      assertArtifactReadActive(signal);
      await rename(
        temporary,
        appendCallerPath(this.selection.directory, "current.json"),
      );
      const previous = this.#source;
      this.#source = source;
      this.#publishedInput = path;
      this.#pendingRemoval.delete(destination);
      this.#pendingRemoval.delete(temporary);
      if (previous !== null)
        this.#pendingRemoval.add(
          appendCallerPath(this.selection.directory, previous.file),
        );
    } catch (cause: unknown) {
      primary = cause;
      failed = true;
    }
    try {
      await this.retryCleanup();
    } catch (cause: unknown) {
      if (failed)
        throw analysisErrorWithCleanupFailure(
          ghidraFileFailure(primary, "checkpoint_program", {
            path: this.selection.directory,
          }),
          ghidraFileFailure(cause, "checkpoint_program", {
            path: this.selection.directory,
          }),
        );
      throw cause;
    }
    if (failed) throw primary;
    assertArtifactReadActive(signal);
  }

  async retryCleanup(): Promise<void> {
    for (const path of this.#pendingRemoval) {
      try {
        await rm(path, { force: true });
        this.#pendingRemoval.delete(path);
      } catch (cause: unknown) {
        const error = new ProviderCleanupError(
          "ghidra",
          [...this.#pendingRemoval],
          {
            reason: `Checkpoint file cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            checkpoint: this.observation,
          },
          { cause },
        );
        this.#cleanupFailures.add(error);
        throw error;
      }
    }
    for (const failure of this.#cleanupFailures) failure.resolveCleanup();
    this.#cleanupFailures.clear();
  }
  async close(): Promise<void> {
    await this.retryCleanup();
    await this.#lease?.release();
    this.#lease = undefined;
  }
}
