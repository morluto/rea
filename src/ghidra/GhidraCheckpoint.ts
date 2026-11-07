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
import type { GhidraTransportKind } from "./GhidraTransport.js";

/** Checkpoint saves require the Unix bridge's mutation authority. */
export const ghidraCheckpointTransportConflict = (
  directory: string | undefined,
  transport: GhidraTransportKind,
): ConfigurationError | null => {
  if (directory === undefined || transport === "unix-socket") return null;
  const constraint =
    "Ghidra checkpoints require the Unix socket bridge; unset REA_GHIDRA_CHECKPOINT_DIR or select unix-socket with REA_GHIDRA_BRIDGE_TRANSPORT on a supported POSIX host.";
  return new ConfigurationError(constraint, {
    settings: [
      { setting: "REA_GHIDRA_CHECKPOINT_DIR", constraint },
      { setting: "REA_GHIDRA_BRIDGE_TRANSPORT", constraint },
    ],
  });
};
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  withArtifactFileHandle,
  withArtifactRegularFile,
  assertArtifactReadActive,
  artifactFilePrimaryFacts,
  mapArtifactFileFailure,
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
const sourceIdentitySchema = z
  .object({
    file: z.string().regex(/^program-[a-f0-9-]{36}\.gzf$/),
    sha256: digest,
  })
  .strict();
const sourceSchema = sourceIdentitySchema.extend({
  kind: z.enum(["initial-analysis", "retained"]),
});
type CheckpointSource = z.infer<typeof sourceSchema>;
const manifestIdentitySchema = z.object({
  target_sha256: digest,
  base_profile_digest: digest,
});
const manifestSchema = z.union([
  manifestIdentitySchema
    .extend({ version: z.literal(2), source: sourceSchema })
    .strict(),
  // Earlier local checkpoints have no initial-generation proof. Retain their
  // data, binding their identity to the verified content rather than guessing.
  manifestIdentitySchema
    .extend({ version: z.literal(1), source: sourceIdentitySchema })
    .strict()
    .transform((value) => ({
      ...value,
      version: 2 as const,
      source: { ...value.source, kind: "retained" as const },
    })),
]);
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
  selection: Omit<GhidraCheckpointSelection, "state">,
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
    throw ghidraFileFailure(
      mapArtifactFileFailure(cause, (primary) =>
        primary instanceof SyntaxError || primary instanceof z.ZodError
          ? failure(selection.directory, "the manifest is malformed", primary)
          : primary,
      ),
      "resolve_analysis_profile",
      { path: appendCallerPath(selection.directory, "current.json") },
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
    throw ghidraFileFailure(cause, "resolve_analysis_profile", { path });
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
    state: checkpointState(await readSource(selection, resources, signal)),
  };
}

/** One session owns publication, the socket lease, and any failed staging cleanup. */
export class GhidraCheckpoint {
  #lease: OwnedLease | undefined;
  #source: CheckpointSource | null | undefined;
  #state: GhidraCheckpointSelection["state"];
  readonly #pendingRemoval = new Set<string>();
  readonly #cleanupFailures = new Set<ProviderCleanupError>();
  #publishedInput: string | undefined;
  constructor(
    readonly selection: GhidraCheckpointSelection,
    private readonly resources: ArtifactResourceScope,
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
    this.#source = undefined;
    const current = await readSource(this.selection, this.resources, signal);
    const generation = checkpointState(current);
    const aligned =
      generation.kind === "initial-analysis"
        ? this.#state.kind === "initial-analysis"
        : this.#state.kind === "retained" &&
          this.#state.sha256 === generation.sha256;
    if (!aligned)
      throw failure(
        directory,
        "the checkpoint changed after profile selection; reopen the target",
      );
    assertArtifactReadActive(signal);
    this.#source = current;
    return current === null
      ? undefined
      : { path: join(directory, current.file), sha256: current.sha256 };
  }

  /** Publish a new immutable blob, then atomically replace its manifest. */
  async publish(path: string, signal?: AbortSignal): Promise<void> {
    if (this.#lease === undefined || this.#source === undefined)
      throw failure(
        this.selection.directory,
        "publication has no admitted session lease",
      );
    const previous = this.#source;
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
      const source: CheckpointSource = {
        file,
        sha256,
        kind: previous === null ? "initial-analysis" : "retained",
      };
      for (const [output, bytes] of [
        [destination, undefined],
        [
          temporary,
          JSON.stringify({
            version: 2,
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
      this.#source = source;
      this.#state = checkpointState(source);
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
    if (failed)
      throw ghidraFileFailure(primary, "checkpoint_program", {
        path: this.selection.directory,
      });
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
