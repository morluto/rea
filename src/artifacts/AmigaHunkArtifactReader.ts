import type { FileHandle } from "node:fs/promises";

import { ParseFailureError, type LimitRef } from "../domain/parseFailure.js";
import type { AmigaHunkMetadata } from "../domain/formatMetadata/packageAndGameMetadata.js";
import {
  AMIGA_HUNK_HUNK_LIMIT,
  AMIGA_HUNK_MAX_FILE_BYTES,
  AMIGA_HUNK_RELOCATION_LIMIT,
  AMIGA_HUNK_RELOCATION_RECORD_LIMIT,
  AMIGA_HUNK_SYMBOL_LIMIT,
  amigaHunkEntryMetadata,
  amigaHunkMetadata,
  parseAmigaHunk,
  type AmigaHunkEntry,
  type AmigaHunkFile,
  type AmigaHunkLimits,
} from "../domain/amigaHunk.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
  type ArtifactReaderFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

/**
 * AmigaOS Hunk load and object files. Load-file code and data hunks are
 * stored ranges of the file; object files are listed without entries.
 * Relocations are reported and not applied. Nothing is executed.
 */
export class AmigaHunkArtifactReader extends PositionalArtifactReader<AmigaHunkMetadata> {
  override readonly format = "amiga-hunk" as const;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly limits?: AmigaHunkLimits,
  ) {
    super(path, "Amiga Hunk", admitted);
  }

  formatMetadata(): AmigaHunkMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<AmigaHunkMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const maxFile = this.limits?.maxFileBytes ?? AMIGA_HUNK_MAX_FILE_BYTES;
    if (initial.size > maxFile)
      throw artifactFixedLimitFailure(
        {
          name: "The Amiga Hunk file allowance",
          kind: "bytes",
          limit: maxFile,
          unit: "bytes",
        },
        `Amiga Hunk file is ${String(initial.size)} bytes, above the ${String(maxFile)}-byte allowance.`,
        "capacity",
      );
    const image = await this.readImage(handle, initial.size, signal);
    return {
      entries: image.entries.map(entryOf),
      coverage: {
        status: image.limitations.length === 0 ? "complete" : "unknown",
        limitations: image.limitations.map((item) => item.detail),
      },
      formatMetadata: amigaHunkMetadata(image),
    };
  }

  private async readImage(
    handle: FileHandle,
    size: number,
    signal: AbortSignal | undefined,
  ): Promise<AmigaHunkFile> {
    try {
      const bytes = await readArtifactFileBytes(
        this.format,
        handle,
        0,
        size,
        size,
        signal,
      );
      return parseAmigaHunk(bytes, this.limits);
    } catch (cause: unknown) {
      if (cause instanceof ParseFailureError && cause.failure.kind === "limit")
        throw countedLimitFailure(cause.failure.limit, cause, signal);
      throw artifactParseFailure(cause, signal);
    }
  }
}

const entryOf = (entry: AmigaHunkEntry): PositionalArtifactEntry => ({
  path: entry.path,
  kind: "file",
  declaredSize: entry.storedBytes,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: entry.byteOffset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [],
  adapterKey: `amiga-hunk:${entry.path}`,
  formatMetadata: amigaHunkEntryMetadata(entry),
});

const countedLimitFailure = (
  limit: LimitRef,
  cause: ParseFailureError<"limit">,
  signal: AbortSignal | undefined,
): ArtifactReaderFailure => {
  if (limit.name === AMIGA_HUNK_HUNK_LIMIT)
    return artifactFixedLimitFailure(
      {
        name: "The Amiga Hunk hunk-count allowance",
        kind: "count",
        limit: limit.maximum,
        unit: "hunks",
      },
      cause.message,
      "capacity",
      { cause },
    );
  if (limit.name === AMIGA_HUNK_RELOCATION_LIMIT)
    return artifactFixedLimitFailure(
      {
        name: "The Amiga Hunk relocation allowance",
        kind: "count",
        limit: limit.maximum,
        unit: "relocations",
      },
      cause.message,
      "capacity",
      { cause },
    );
  if (limit.name === AMIGA_HUNK_RELOCATION_RECORD_LIMIT)
    return artifactFixedLimitFailure(
      {
        name: "The Amiga Hunk relocation-record allowance",
        kind: "count",
        limit: limit.maximum,
        unit: "records",
      },
      cause.message,
      "capacity",
      { cause },
    );
  if (limit.name === AMIGA_HUNK_SYMBOL_LIMIT)
    return artifactFixedLimitFailure(
      {
        name: "The Amiga Hunk symbol-byte allowance",
        kind: "bytes",
        limit: limit.maximum,
        unit: "bytes",
      },
      cause.message,
      "capacity",
      { cause },
    );
  throw artifactParseFailure(cause, signal);
};
