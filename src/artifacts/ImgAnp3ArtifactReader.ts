import { setImmediate } from "node:timers/promises";

import type {
  Anp3Metadata,
  ImgV2Metadata,
} from "../domain/artifactFormatMetadata.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { parseAnp3Package } from "../domain/anp3AnimationFormat.js";
import {
  IMG_V2_DIRECTORY_ENTRY_BYTES,
  IMG_V2_HEADER_BYTES,
  IMG_V2_SECTOR_BYTES,
  imgV2DirectoryBytes,
  hasImgV2Header,
  parseImgV2Directory,
  readImgV2EntryCount,
} from "../domain/imgArchiveFormat.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

/** Encoded retained entry metadata for one archive or package. */
const MAX_RETAINED_METADATA_BYTES = 64 * 1024 * 1024;
/** ANP3 packages are parsed in memory; shipped packages are a few MiB. */
const MAX_ANP3_BYTES = 16 * 1024 * 1024;
/**
 * One 32-byte IMG row retains under 1 KiB of encoded entry metadata, even with
 * every name byte JSON-escaped, so the directory is admitted before decoding.
 */
const MAX_RETAINED_BYTES_PER_DIRECTORY_BYTE = 32;
const ENTRY_YIELD_INTERVAL = 256;

type ImgAnp3Format = "img-v2" | "anp3";
const LABEL: Readonly<Record<ImgAnp3Format, string>> = {
  "img-v2": "IMG",
  anp3: "ANP3",
};

interface ImgAnp3Layout {
  readonly metadata: ImgV2Metadata | Anp3Metadata;
  readonly entries: readonly PositionalArtifactEntry[];
  readonly limitations: readonly string[];
}

/**
 * Inventory IMG version 2 members or ANP3 animation records as stored byte
 * ranges of one admitted descriptor. Nothing is decompressed or decoded
 * beyond the directory and animation headers.
 */
export class ImgAnp3ArtifactReader extends PositionalArtifactReader {
  override readonly format: ImgAnp3Format;
  readonly #label: string;
  #metadata: ImgV2Metadata | Anp3Metadata | undefined;

  constructor(
    format: ImgAnp3Format,
    path: string,
    admitted?: StableRegularFileDescriptor,
  ) {
    super(path, LABEL[format], admitted);
    this.format = format;
    this.#label = LABEL[format];
  }

  formatMetadata(): ImgV2Metadata | Anp3Metadata | undefined {
    return this.#metadata === undefined
      ? undefined
      : structuredClone(this.#metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries> {
    const layout =
      this.format === "img-v2"
        ? await this.#imgLayout(signal)
        : await this.#ifpLayout(signal);
    let retainedBytes = 0;
    let index = 0;
    for (const entry of layout.entries) {
      if (index % ENTRY_YIELD_INTERVAL === 0) await setImmediate();
      index += 1;
      this.assertOpen(signal);
      retainedBytes += jsonValueByteLength(
        {
          path: entry.path,
          sourcePath: entry.sourcePath ?? null,
          formatMetadata: entry.formatMetadata ?? null,
        },
        MAX_RETAINED_METADATA_BYTES - retainedBytes,
      );
      if (retainedBytes > MAX_RETAINED_METADATA_BYTES)
        throw new ArtifactReaderFailure(
          "limit",
          `${this.#label} directory exceeds the 64 MiB encoded metadata budget`,
          { boundary: "memory" },
        );
    }
    await this.verifyCarrier(signal);
    this.#metadata = layout.metadata;
    return {
      entries: layout.entries,
      coverage:
        layout.limitations.length === 0
          ? undefined
          : { status: "complete", limitations: [...layout.limitations] },
    };
  }

  async #imgLayout(signal?: AbortSignal): Promise<ImgAnp3Layout> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const size = initial.size;
    if (size < IMG_V2_HEADER_BYTES)
      throw formatFailure(this.#label, "header is truncated");
    const header = await readArtifactFileBytes(
      handle,
      0,
      IMG_V2_HEADER_BYTES,
      size,
      signal,
    );
    if (!hasImgV2Header(header))
      throw formatFailure(this.#label, "missing VER2 signature");
    const count = readImgV2EntryCount(header);
    const directoryBytes = imgV2DirectoryBytes(count, size);
    if (!directoryBytes.ok)
      throw formatFailure(this.#label, directoryBytes.error);
    if (
      directoryBytes.value * MAX_RETAINED_BYTES_PER_DIRECTORY_BYTE >
      MAX_RETAINED_METADATA_BYTES
    )
      throw new ArtifactReaderFailure(
        "limit",
        `IMG directory declares ${String(count)} entries; the 64 MiB encoded metadata budget admits ${String(MAX_RETAINED_METADATA_BYTES / MAX_RETAINED_BYTES_PER_DIRECTORY_BYTE / IMG_V2_DIRECTORY_ENTRY_BYTES)}`,
        { boundary: "memory" },
      );
    const directory = await readArtifactFileBytes(
      handle,
      IMG_V2_HEADER_BYTES,
      directoryBytes.value,
      size,
      signal,
    );
    const rows = parseImgV2Directory(directory, size);
    if (!rows.ok) throw formatFailure(this.#label, rows.error);
    // Rows may alias one range; charge each readable occurrence once.
    const budget = artifactExpansionBudgetBytes(size);
    let declared = 0;
    for (const row of rows.value) {
      declared += row.byteLength;
      if (declared > budget)
        throw new ArtifactReaderFailure(
          "limit",
          `IMG entries declare ${String(declared)} bytes, exceeding this archive's ${String(budget)}-byte expansion budget`,
        );
    }
    return {
      metadata: {
        kind: "img-v2",
        version: 2,
        entry_count: count,
        sector_bytes: IMG_V2_SECTOR_BYTES,
        directory_end: IMG_V2_HEADER_BYTES + directoryBytes.value,
      },
      entries: rows.value.map((row) => ({
        path: row.name,
        sourcePath: row.name,
        kind: "file" as const,
        declaredSize: row.byteLength,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: row.byteOffset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `img-v2-entry:${String(row.index)}`,
        formatMetadata: {
          kind: "img-v2-entry" as const,
          index: row.index,
          name: row.name,
          offset_sectors: row.offsetSectors,
          streaming_sectors: row.streamingSectors,
          archive_sectors: row.archiveSectors,
        },
      })),
      limitations: [
        "IMG member sizes are whole 2048-byte sectors; member bytes include any sector padding after the stored file.",
      ],
    };
  }

  async #ifpLayout(signal?: AbortSignal): Promise<ImgAnp3Layout> {
    const { handle, initial } = await this.verifyCarrier(signal);
    if (initial.size > MAX_ANP3_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `ANP3 package is ${String(initial.size)} bytes, above the fixed 16 MiB in-memory allowance. No runtime override.`,
        { boundary: "memory" },
      );
    const bytes = await readArtifactFileBytes(
      handle,
      0,
      initial.size,
      initial.size,
      signal,
    );
    const parsed = parseAnp3Package(bytes);
    if (!parsed.ok) throw formatFailure(this.#label, parsed.error);
    const { animations } = parsed.value;
    const width = Math.max(4, String(animations.length).length);
    const unknownDurations = animations.filter(
      (animation) =>
        animation.durationSeconds === null && animation.keyframeCount > 0,
    ).length;
    return {
      metadata: {
        kind: "anp3",
        signature: "ANP3",
        package_name: parsed.value.packageName,
        declared_end_offset: parsed.value.declaredEndOffset,
        animation_count: animations.length,
        trailing_bytes: parsed.value.trailingBytes,
      },
      entries: animations.map((animation) => ({
        path: `animations/${String(animation.index).padStart(width, "0")}-${pathComponent(animation.name)}.bin`,
        sourcePath: animation.name,
        kind: "file" as const,
        declaredSize: animation.byteLength,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: animation.byteOffset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `anp3-animation:${String(animation.index)}`,
        formatMetadata: {
          kind: "anp3-animation" as const,
          index: animation.index,
          name: animation.name,
          object_count: animation.bones.length,
          declared_frame_data_bytes: animation.declaredFrameDataBytes,
          flags: animation.flags,
          keyframe_count: animation.keyframeCount,
          duration_seconds: animation.durationSeconds,
          bones: animation.bones.map((bone) => ({ ...bone })),
        },
      })),
      limitations:
        unknownDurations === 0
          ? []
          : [
              `${String(unknownDurations)} ANP3 animation(s) store a non-finite final keyframe time; their duration is unknown.`,
            ],
    };
  }
}

const formatFailure = (label: string, detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `${label} is malformed: ${detail}`);

/** Animation names become one portable path component; metadata keeps the name. */
const pathComponent = (name: string): string =>
  name.replaceAll(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+$/u, "_") || "unnamed";
