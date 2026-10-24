import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Readable, Transform, pipeline } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import type { NodeSeaMetadata } from "../domain/artifactFormatMetadata.js";
import { artifactIntegrityDetails } from "../domain/artifactIntegrity.js";
import { normalizeArtifactPath } from "./ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { hashReadable } from "./ArtifactHash.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import {
  NODE_SEA_BLOB_TOO_LARGE,
  NODE_SEA_MAX_BLOB_BYTES,
  NODE_SEA_RESERVED_COLLISION,
  decodeNodeSeaBlob,
  nodeSeaAssetCollision,
  type DecodedNodeSeaBlob,
  type NodeSeaByteRange,
} from "./nodeSea/NodeSeaBlob.js";
import {
  locateNodeSea,
  readNodeSeaBlob,
  scanNodeSeaFuse,
} from "./nodeSea/NodeSeaLocation.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  RegularFileOperationCancelled,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";

const SNAPSHOT_PATH = "__node_sea__/snapshot";
const CODE_CACHE_PATH = "__node_sea__/code-cache";

type NodeSeaRole = "main-script" | "snapshot" | "code-cache" | "asset";

/** Read a Node.js SEA blob out of a Mach-O, ELF, or PE carrier without running it. */
export class NodeSeaArtifactReader implements ArtifactReader {
  readonly format = "node-sea" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #streams = new Set<Readable>();
  #owner: OwnedFileHandle | undefined;
  #initial: Stats | undefined;
  #opening: Promise<FileHandle> | undefined;
  #prepared: Promise<void> | undefined;
  #header: NodeSeaMetadata | undefined;
  #closing = false;
  #boundSha256: string | undefined;

  constructor(
    private readonly path: string,
    private readonly admitted?: StableRegularFileDescriptor,
  ) {}

  formatMetadata(): NodeSeaMetadata | undefined {
    if (this.#header === undefined) return undefined;
    return { ...this.#header, exec_argv: [...this.#header.exec_argv] };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      const handle = await this.#assertStable(signal);
      const observed =
        this.#boundSha256 ??
        (
          await hashReadable(
            readFileHandleChunks(handle, {
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  "Node SEA verification cancelled",
                  { cause: reason },
                ),
            }),
            signal,
          )
        ).sha256;
      await this.#assertStable(signal);
      if (observed !== expectedSha256)
        throw new ArtifactReaderFailure(
          "integrity",
          "Node SEA carrier changed after inventory",
          undefined,
          artifactIntegrityDetails(
            ".",
            { algorithm: "sha256", digest: expectedSha256 },
            observed,
            false,
          ),
        );
      this.#boundSha256 = observed;
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#assertStable(signal);
    });
    const contradiction = this.#header?.fuse_contradiction;
    if (contradiction !== null && contradiction !== undefined)
      options?.onCoverage?.({
        status: "complete",
        limitations: [contradiction],
      });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          "Node SEA entry does not match its owning inventory",
        );
      const handle = await this.#assertStable(signal);
      this.#assertOpen(signal);
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw formatFailure("member has no physical byte range");
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  "Node SEA read cancelled",
                  {
                    cause: reason,
                  },
                ),
            });
      const output = this.#memberStream(stored, signal);
      output.on("error", () => undefined);
      this.#streams.add(output);
      void this.#scope
        .run(
          () =>
            new Promise<void>((resolve) => {
              pipeline(source, output, () => {
                this.#streams.delete(output);
                resolve();
              });
            }),
        )
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error("Node SEA stream ownership failed", { cause }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure("unavailable", "Node SEA reader closed"),
      );
    await this.#scope.close();
    if (this.#owner !== undefined) {
      await this.#owner.close();
      this.#owner = undefined;
    }
    this.#entries.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Node SEA reader is closed",
      );
  }

  #open(signal?: AbortSignal): Promise<FileHandle> {
    this.#opening ??= this.#admit(signal);
    return this.#opening;
  }

  async #admit(signal?: AbortSignal): Promise<FileHandle> {
    try {
      const handle =
        this.admitted?.handle ??
        (await openRegularFile(this.path, { symlinks: "reject", signal }));
      if (this.admitted === undefined)
        this.#owner = new OwnedFileHandle(handle);
      this.#initial = this.admitted?.initial ?? (await handle.stat());
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure) {
        this.#owner = cause.owner;
        throw ArtifactReaderFailure.withCleanup(
          admissionFailure(cause.cause, this.path),
          ArtifactReaderFailure.cleanupObservation(
            cause.cleanupCause,
            this.path,
          ),
        );
      }
      throw admissionFailure(cause, this.path);
    }
  }

  async #assertStable(signal?: AbortSignal): Promise<FileHandle> {
    assertArtifactReadActive(signal);
    const handle = await this.#open(signal);
    const observed = await handle.stat();
    if (
      this.#initial === undefined ||
      !sameRegularFileState(this.#initial, observed)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Node SEA source identity changed: ${this.path}`,
      );
    assertArtifactReadActive(signal);
    return handle;
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const handle = await this.#assertStable(signal);
    const initial = this.#initial;
    if (initial === undefined)
      throw formatFailure("source identity was not admitted");
    const location = await locateNodeSea(handle, initial.size, signal);
    if (location === undefined) throw formatFailure("blob was not found");
    if (location.blobLength > NODE_SEA_MAX_BLOB_BYTES)
      throw new ArtifactReaderFailure("limit", NODE_SEA_BLOB_TOO_LARGE, {
        boundary: "memory",
      });
    const decoded = decodeNodeSeaBlob(
      await readNodeSeaBlob(handle, location, initial.size, signal),
    );
    const fuse = await scanNodeSeaFuse(handle, initial.size, signal);
    const members = seaMembers(decoded);
    let declaredBytes = 0n;
    const expansionBudget = BigInt(
      artifactExpansionBudgetBytes(location.blobLength),
    );
    members.forEach((member, index) => {
      declaredBytes += BigInt(member.range.length);
      if (declaredBytes > expansionBudget)
        throw new ArtifactReaderFailure(
          "limit",
          `Node SEA readable entries declare ${String(declaredBytes)} bytes, exceeding this blob's ${String(expansionBudget)}-byte expansion budget`,
          { boundary: "memory" },
        );
      const start = location.blobOffset + member.range.offset;
      if (start > initial.size || member.range.length > initial.size - start)
        throw formatFailure(`member exceeds the carrier: ${member.path}`);
      const entry = {
        path: member.path,
        kind: "file" as const,
        declaredSize: member.range.length,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: start,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `node-sea:${String(index)}`,
        formatMetadata: {
          kind: "node-sea-entry" as const,
          role: member.role,
          source_path: member.path,
          index,
        },
      } satisfies ArtifactEntry;
      this.#entries.set(entry.adapterKey, entry);
    });
    this.#header = {
      kind: "node-sea",
      magic: decoded.magic,
      flags: decoded.flags,
      disable_experimental_sea_warning: decoded.disableExperimentalSeaWarning,
      use_snapshot: decoded.useSnapshot,
      use_code_cache: decoded.useCodeCache,
      include_assets: decoded.includeAssets,
      include_exec_argv: decoded.includeExecArgv,
      exec_argv_extension: decoded.execArgvExtension,
      exec_argv: [...decoded.execArgv],
      code_path: decoded.codePath,
      carrier: location.carrier,
      blob_offset: location.blobOffset,
      blob_length: location.blobLength,
      fuse_state: fuse.fuseState,
      fuse_sentinel: fuse.fuseSentinel,
      fuse_contradiction: fuse.fuseContradiction,
    };
    await this.#assertStable(signal);
  }

  #memberStream(entry: ArtifactEntry, signal?: AbortSignal): Transform {
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize)
        throw formatFailure(`member ended early: ${entry.path}`);
      await this.#assertStable(signal);
    };
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        void check().then(
          () => callback(),
          (cause: unknown) =>
            callback(
              cause instanceof Error
                ? cause
                : new Error("Node SEA read failed", { cause }),
            ),
        );
      },
    });
  }
}

const seaMembers = (
  decoded: DecodedNodeSeaBlob,
): {
  readonly path: string;
  readonly role: NodeSeaRole;
  readonly range: NodeSeaByteRange;
}[] => {
  const claimed = new Map<string, NodeSeaRole>();
  const claim = (path: string, role: NodeSeaRole): string => {
    const normalized = normalizeArtifactPath(path);
    const existing = claimed.get(normalized);
    if (existing !== undefined)
      throw new ArtifactReaderFailure(
        "format",
        role === "asset" && existing === "asset"
          ? nodeSeaAssetCollision(normalized)
          : role === "asset" || existing === "asset"
            ? NODE_SEA_RESERVED_COLLISION
            : `Node SEA entry path collides: ${normalized}`,
      );
    claimed.set(normalized, role);
    return path;
  };
  const members: {
    path: string;
    role: NodeSeaRole;
    range: NodeSeaByteRange;
  }[] = [];
  if (decoded.mainScript !== null)
    members.push({
      path: claim(decoded.codePath, "main-script"),
      role: "main-script",
      range: decoded.mainScript,
    });
  if (decoded.snapshot !== null)
    members.push({
      path: claim(SNAPSHOT_PATH, "snapshot"),
      role: "snapshot",
      range: decoded.snapshot,
    });
  if (decoded.codeCache !== null)
    members.push({
      path: claim(CODE_CACHE_PATH, "code-cache"),
      role: "code-cache",
      range: decoded.codeCache,
    });
  for (const asset of decoded.assets)
    members.push({
      path: claim(asset.name, "asset"),
      role: "asset",
      range: asset.range,
    });
  return members;
};

const formatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `Node SEA blob is malformed: ${detail}`);

const admissionFailure = (
  cause: unknown,
  path: string,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof RegularFileOperationCancelled)
    return new ArtifactReaderFailure(
      "cancelled",
      "Node SEA admission cancelled",
      {
        cause: cause.reason,
      },
    );
  if (cause instanceof NonRegularFileReadError)
    return new ArtifactReaderFailure(
      "format",
      `Node SEA source is not a regular file: ${path}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "io",
    cause instanceof Error
      ? cause.message
      : `Cannot admit Node SEA source: ${path}`,
    { cause },
  );
};
