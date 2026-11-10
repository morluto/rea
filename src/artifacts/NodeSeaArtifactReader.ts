import type { NodeSeaAdmission } from "./nodeSea/NodeSeaAdmission.js";
import { setImmediate } from "node:timers/promises";

import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import type { NodeSeaMetadata } from "../domain/artifactFormatMetadata.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  NODE_SEA_BLOB_TOO_LARGE,
  NODE_SEA_MAX_BLOB_BYTES,
  decodeNodeSeaBlob,
  type DecodedNodeSeaBlob,
  type NodeSeaByteRange,
} from "./nodeSea/NodeSeaBlob.js";
import {
  locateNodeSea,
  readNodeSeaBlob,
  scanNodeSeaFuse,
  type NodeSeaLocation,
} from "./nodeSea/NodeSeaLocation.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

const SNAPSHOT_PATH = "__node_sea__/snapshot";
const CODE_CACHE_PATH = "__node_sea__/code-cache";
const MAIN_FALLBACK_PATH = "__node_sea__/main.cjs";
const ASSET_FALLBACK_PREFIX = "__node_sea__/assets/";

type NodeSeaRole = "main-script" | "snapshot" | "code-cache" | "asset";

/** Read a Node.js SEA blob out of a Mach-O, ELF, or PE carrier without running it. */
export class NodeSeaArtifactReader extends PositionalArtifactReader {
  override readonly format = "node-sea" as const;
  #header: NodeSeaMetadata | undefined;
  #admission: NodeSeaAdmission | undefined;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor | NodeSeaAdmission,
  ) {
    const admission =
      admitted !== undefined && "kind" in admitted ? admitted : undefined;
    super(
      path,
      "Node SEA",
      admitted !== undefined && "kind" in admitted ? admitted.source : admitted,
    );
    this.#admission = admission;
  }

  formatMetadata(): NodeSeaMetadata | undefined {
    if (this.#header === undefined) return undefined;
    return { ...this.#header, exec_argv: [...this.#header.exec_argv] };
  }

  /** Also drop the admitted decode, which only a completed preparation releases. */
  override async close(): Promise<void> {
    await super.close();
    this.#admission = undefined;
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries> {
    const { handle, initial } = await this.verifyCarrier(signal);
    // Freshness remains owned by ArtifactFileSource even when classification
    // already decoded this exact borrowed descriptor's blob.
    let location: NodeSeaLocation;
    let decoded: DecodedNodeSeaBlob;
    if (this.#admission !== undefined) {
      ({ location, decoded } = this.#admission);
    } else {
      const found = await locateNodeSea(handle, initial.size, signal);
      if (found === undefined) throw formatFailure("blob was not found");
      location = found;
      if (location.blobLength > NODE_SEA_MAX_BLOB_BYTES)
        throw new ArtifactReaderFailure("limit", NODE_SEA_BLOB_TOO_LARGE, {
          boundary: "memory",
        });
      decoded = await decodeNodeSeaBlob(
        await readNodeSeaBlob(handle, location, initial.size, signal),
        signal,
      );
    }
    const fuse = await scanNodeSeaFuse(handle, initial.size, signal);
    const entries: PositionalArtifactEntry[] = [];
    let declaredBytes = 0n;
    const expansionBudget = BigInt(
      artifactExpansionBudgetBytes(location.blobLength),
    );
    let index = 0;
    for (const member of seaMembers(decoded)) {
      if (index % 256 === 0) await setImmediate();
      this.assertOpen(signal);
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
          source_path: member.sourcePath,
          index,
        },
        sourcePath: member.sourcePath,
      } satisfies PositionalArtifactEntry;
      entries.push(entry);
      index += 1;
    }
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
    await this.verifyCarrier(signal);
    this.#admission = undefined;
    return {
      entries,
      coverage:
        fuse.fuseContradiction === null
          ? undefined
          : { status: "complete", limitations: [fuse.fuseContradiction] },
    };
  }
}

function* seaMembers(decoded: DecodedNodeSeaBlob): Generator<{
  readonly path: string;
  readonly sourcePath: string;
  readonly role: NodeSeaRole;
  readonly range: NodeSeaByteRange;
}> {
  const registry = new ArtifactPathRegistry();
  const claimed = new Set<string>();
  const reserve = (path: string): string => {
    if (claimed.has(path))
      throw new ArtifactReaderFailure(
        "path",
        `Node SEA entry path collides: ${path}`,
      );
    registry.add(path, "file");
    claimed.add(path);
    return path;
  };
  const mappedPath = (raw: string, fallback: string): string => {
    try {
      const normalized = normalizeArtifactPath(raw);
      if (
        normalized !== "__node_sea__" &&
        !normalized.startsWith("__node_sea__/")
      )
        return reserve(normalized);
    } catch (cause) {
      if (!(cause instanceof ArtifactReaderFailure) || cause.reason !== "path")
        throw cause;
    }
    return reserve(fallback);
  };
  if (decoded.mainScript !== null)
    yield {
      path: mappedPath(decoded.codePath, MAIN_FALLBACK_PATH),
      sourcePath: decoded.codePath,
      role: "main-script",
      range: decoded.mainScript,
    };
  if (decoded.snapshot !== null)
    yield {
      path: reserve(SNAPSHOT_PATH),
      sourcePath: SNAPSHOT_PATH,
      role: "snapshot",
      range: decoded.snapshot,
    };
  if (decoded.codeCache !== null)
    yield {
      path: reserve(CODE_CACHE_PATH),
      sourcePath: CODE_CACHE_PATH,
      role: "code-cache",
      range: decoded.codeCache,
    };
  for (const [ordinal, asset] of decoded.assets.entries())
    yield {
      path: mappedPath(
        asset.name,
        `${ASSET_FALLBACK_PREFIX}${String(ordinal)}`,
      ),
      sourcePath: asset.name,
      role: "asset",
      range: asset.range,
    };
}

const formatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `Node SEA blob is malformed: ${detail}`);
