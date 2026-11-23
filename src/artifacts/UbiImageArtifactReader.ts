import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { Readable } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

import type {
  UbiImageMetadata,
  UbiVolumeMetadata,
} from "../domain/artifactFormatMetadata.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  assertArtifactReadActive,
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
  copyArtifactEntry,
  assertProducedEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
  ArtifactResourceScope,
  ArtifactFileSource,
} from "../resources/index.js";
import {
  ArtifactStreamLifecycle,
  checkedArtifactMemberStream,
  ownArtifactStream,
} from "./OwnedArtifactStream.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  parseUbiImage,
  ubiVolumeExtractRefusalLimitation,
  UBI_PEB_COUNT_LIMIT,
  type UbiImage,
  type UbiImageParseError,
  type UbiLebRange,
  type UbiVolume,
} from "../domain/firmware/ubiImage.js";

const LABEL = "UBI image";

type UbiEntry = ArtifactEntry & {
  readonly volume: UbiVolume;
  readonly formatMetadata: UbiVolumeMetadata;
};

/** Inventory UBI volumes and reassemble them from their logical eraseblocks. */
export class UbiImageArtifactReader implements ArtifactReader {
  readonly format = "ubi-image" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, UbiEntry>();
  readonly #lifecycle = new ArtifactStreamLifecycle(LABEL);
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #image: UbiImage | undefined;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, LABEL, admitted);
  }

  formatMetadata(): UbiImageMetadata | undefined {
    return this.#image === undefined ? undefined : toMetadata(this.#image);
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    options?.onCoverage?.({
      status: "complete",
      limitations: [...(this.#image?.limitations ?? [])],
    });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(publicEntry(entry));
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      assertProducedEntry(
        entry,
        stored,
        "UBI volume does not match its owning inventory",
      );
      const { volume } = stored;
      if (volume.extractRefusal !== null) {
        const limitation = ubiVolumeExtractRefusalLimitation(
          volume.extractRefusal,
        );
        throw new ArtifactEntryContentUnavailable(
          `UBI volume ${stored.path} cannot be reassembled: ${limitation}`,
          limitation,
          { traversal: { status: "unknown", limitations: [limitation] } },
        );
      }
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const lifecycle = this.#lifecycle.member(signal);
      const { signal: streamSignal, cancellationFailure } = lifecycle;
      const source = Readable.from(
        volumeChunks(handle, volume.ranges, streamSignal, cancellationFailure),
        { objectMode: false },
      );
      const output = checkedArtifactMemberStream(
        stored,
        LABEL,
        (detail) => formatFailure(detail),
        () => lifecycle.verify((active) => this.#source.read(active)),
      );
      ownArtifactStream(source, output, {
        scope: this.#scope,
        signal: streamSignal,
        cancellationFailure,
        label: LABEL,
      });
      return output;
    });
  }

  async close(): Promise<void> {
    this.#lifecycle.close();
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
    this.#image = undefined;
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#lifecycle.closed)
      throw new ArtifactReaderFailure("unavailable", `${LABEL} reader closed`);
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const size = initial.size;
    const parsed = await parseUbiImage(
      size,
      (offset, length) =>
        readArtifactFileBytes(handle, offset, length, size, signal),
      {
        checkpoint: async (yieldControl) => {
          if (yieldControl) await setImmediate();
          this.#assertOpen(signal);
        },
      },
    );
    if (!parsed.ok) throw parseFailure(parsed.error);
    await this.#source.read(signal);
    this.#assertOpen(signal);
    const image = parsed.value;
    this.#image = image;
    this.#entries.clear();
    for (const volume of image.volumes) {
      const entry = entryFor(volume);
      this.#entries.set(entry.adapterKey, entry);
    }
  }
}

async function* volumeChunks(
  handle: Pick<FileHandle, "read">,
  ranges: readonly UbiLebRange[],
  signal: AbortSignal,
  cancellationFailure: (reason: unknown) => Error,
): AsyncIterable<Buffer> {
  for (const range of ranges) {
    if (range.length === 0) continue;
    yield* readFileHandleChunks(handle, {
      start: range.offset,
      end: range.offset + range.length - 1,
      signal,
      cancellationFailure,
    }) as AsyncIterable<Buffer>;
  }
}

const formatFailure = (
  detail: string,
  options?: ErrorOptions,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `${LABEL} is malformed: ${detail}`,
    options,
  );

const parseFailure = (failure: UbiImageParseError): ArtifactReaderFailure => {
  switch (failure.kind) {
    case "limit": {
      const parserLimit = failure.failure.limit;
      return new ArtifactReaderFailure("limit", failure.message, {
        boundary: "capacity",
        cause: failure,
        parserLimit,
        fixedAllowance: {
          kind: "parser",
          name: `The ${parserLimit.name} allowance`,
          limit: parserLimit.maximum,
          unit:
            parserLimit.name === UBI_PEB_COUNT_LIMIT ? "eraseblocks" : "bytes",
        },
      });
    }
    case "unsupported":
      return new ArtifactReaderFailure("unavailable", failure.message, {
        cause: failure,
      });
    case "malformed":
      return formatFailure(failure.message, { cause: failure });
  }
};

const volumeFacts = (volume: UbiVolume) => ({
  id: volume.id,
  name: volume.name,
  name_bytes_hex: volume.nameBytesHex,
  type: volume.type,
  reserved_pebs: volume.reservedPebs,
  alignment: volume.alignment,
  data_pad: volume.dataPad,
  update_marker: volume.updateMarker,
  flags: volume.flags,
  autoresize: volume.autoresize,
  usable_leb_size: volume.usableLebSize,
  used_ebs: volume.usedEbs,
  mapped_leb_count: volume.mappedLebCount,
  stale_leb_copy_count: volume.staleLebCopyCount,
  missing_leb_count: volume.missingLebCount,
  first_missing_leb: volume.firstMissingLeb,
  data_bytes: volume.dataBytes,
  extractable: volume.extractRefusal === null,
});

/** The returned entry, without the reader's private LEB mapping. */
const publicEntry = ({ volume: _volume, ...entry }: UbiEntry): ArtifactEntry =>
  entry;

const entryFor = (volume: UbiVolume): UbiEntry => ({
  path: volume.path,
  kind: "file",
  declaredSize: volume.dataBytes,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: null,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [...volume.limitations],
  adapterKey: `ubi-image:volume:${String(volume.id)}`,
  formatMetadata: {
    kind: "ubi-volume",
    ...volumeFacts(volume),
    source_ranges: volume.ranges.map(({ lnum, peb, offset, length }) => ({
      lnum,
      peb,
      offset,
      length,
    })),
  },
  sourcePath: volume.path,
  volume,
});

const toMetadata = (image: UbiImage): UbiImageMetadata => ({
  kind: "ubi-image",
  magic: "UBI#",
  version: 1,
  peb_size: image.geometry.pebSize,
  leb_size: image.geometry.lebSize,
  vid_header_offset: image.geometry.vidHeaderOffset,
  data_offset: image.geometry.dataOffset,
  image_seq: image.geometry.imageSeq,
  peb_count: image.geometry.pebCount,
  mapped_peb_count: image.mappedPebCount,
  free_peb_count: image.freePebCount,
  erased_peb_count: image.erasedPebCount,
  corrupt_peb_count: image.corruptPebCount,
  layout_peb_count: image.layoutPebCount,
  stale_leb_copy_count: image.staleLebCopyCount,
  ignored_leb_count: image.ignoredLebCount,
  min_erase_counter: image.minEraseCounter,
  max_erase_counter: image.maxEraseCounter,
  volume_table_slots: image.geometry.volumeTableSlots,
  volume_table_copies_found: image.volumeTable.copiesFound,
  volume_table_copies_valid: image.volumeTable.copiesValid,
  volume_table_copies_agree: image.volumeTable.copiesAgree,
  volume_table_source_leb: image.volumeTable.sourceLnum,
  data_crc_verified: false,
  volumes: image.volumes.map((volume) => ({
    ...volumeFacts(volume),
    path: volume.path,
  })),
});
