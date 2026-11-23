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
  assembleUbiImage,
  checkUbiPebs,
  classifyUbiPeb,
  ubiCandidateGridOffsets,
  ubiVidMinPebSize,
  ubiHasMappedSecondPeb,
  ubiPebSizeCandidates,
  ubiFirstVidHeaderOffset,
  findUbiSpacingConflict,
  parseUbiFirstEcHeader,
  parseUbiVolumeTable,
  ubiAmbiguousPebSize,
  ubiGeometry,
  ubiCopiesToVerify,
  ubiCopyDataMatches,
  ubiLayoutVolumePebs,
  findUbiSmallerGridHeader,
  ubiPebHeadersErased,
  ubiSmallerGridFit,
  ubiSmallerPebSizeHoldsLebs,
  ubiSpacingConflict,
  ubiPebSearchStart,
  ubiSmallerPebSizes,
  ubiSpacingCheckRange,
  ubiVolumeExtractRefusalLimitation,
  ubiVolumeTableBytes,
  UBI_HEADER_BYTES,
  UBI_MAX_PEB_BYTES,
  UBI_PEB_SIZE_LIMIT,
  type UbiImage,
  type UbiImageParseError,
  type UbiLebRange,
  type UbiPeb,
  type UbiVolume,
} from "../domain/firmware/ubiImage.js";

const LABEL = "UBI image";
const SCAN_CHUNK_BYTES = 64 * 1024;

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
    const first = parseUbiFirstEcHeader(
      await readArtifactFileBytes(
        handle,
        0,
        Math.min(size, UBI_HEADER_BYTES),
        size,
        signal,
      ),
      size,
    );
    if (!first.ok) throw parseFailure(first.error);
    // The eraseblock size is the distance to the next erase-counter header
    // past the data the first PEB's VID header declares.
    const vidHeaderOffset = ubiFirstVidHeaderOffset(first.value, size);
    const minPebSize =
      vidHeaderOffset === null
        ? 0
        : ubiVidMinPebSize(
            await readArtifactFileBytes(
              handle,
              vidHeaderOffset,
              UBI_HEADER_BYTES,
              size,
              signal,
            ),
            first.value,
          );
    const scanEnd = Math.min(size, UBI_MAX_PEB_BYTES + UBI_HEADER_BYTES);
    // A mapped PEB can establish the grid even when the dump ends mid-block.
    let next: number | null = null;
    let anyNext: number | null = null;
    for (
      let offset = ubiPebSearchStart(first.value);
      next === null && offset < scanEnd;
      offset += SCAN_CHUNK_BYTES
    ) {
      this.#assertOpen(signal);
      const chunk = await readArtifactFileBytes(
        handle,
        offset,
        Math.min(SCAN_CHUNK_BYTES + UBI_HEADER_BYTES, scanEnd - offset),
        size,
        signal,
      );
      for (const { offset: candidate, header } of ubiPebSizeCandidates(
        chunk,
        offset,
        first.value,
        minPebSize,
      )) {
        anyNext ??= candidate;
        const candidateVid = candidate + first.value.vidHeaderOffset;
        if (
          size % candidate === 0 ||
          (candidateVid + UBI_HEADER_BYTES <= size &&
            ubiHasMappedSecondPeb(
              await readArtifactFileBytes(
                handle,
                candidateVid,
                UBI_HEADER_BYTES,
                size,
                signal,
              ),
              first.value,
              header,
              candidate,
            ))
        ) {
          next = candidate;
          break;
        }
      }
    }
    next ??= anyNext;
    // Skipped eraseblocks before the second header would multiply the size;
    // a header where a smaller eraseblock would begin exposes that. Once the
    // LEBs are read, only the smaller sizes they still admit count.
    const spacingConflict = async (
      candidates: ReadonlySet<number>,
    ): Promise<number | null> => {
      if (next === null) return null;
      const { start, end } = ubiSpacingCheckRange(next, size);
      let found: number | null = null;
      for (
        let offset = start;
        found === null && offset < end;
        offset += SCAN_CHUNK_BYTES
      ) {
        this.#assertOpen(signal);
        const chunk = await readArtifactFileBytes(
          handle,
          offset,
          Math.min(SCAN_CHUNK_BYTES + UBI_HEADER_BYTES, end - offset),
          size,
          signal,
        );
        found = findUbiSpacingConflict(
          chunk,
          offset,
          first.value,
          next,
          candidates,
        );
      }
      return found;
    };
    const conflict =
      next === null
        ? null
        : await spacingConflict(
            ubiCandidateGridOffsets(next, first.value.dataOffset),
          );
    // Until then a spacing conflict keeps its precedence over later failures.
    const failure = (error: UbiImageParseError): ArtifactReaderFailure =>
      parseFailure(
        conflict === null || next === null
          ? error
          : ubiSpacingConflict(next, conflict),
      );
    const measured = ubiGeometry(first.value, next, size, null);
    if (!measured.ok) throw failure(measured.error);
    const pebs: UbiPeb[] = [];
    for (let index = 0; index < measured.value.pebCount; index += 1) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      const peb = classifyUbiPeb(
        await readArtifactFileBytes(
          handle,
          index * measured.value.pebSize,
          measured.value.headerReadBytes,
          size,
          signal,
        ),
        index,
        measured.value,
      );
      if (!peb.ok) throw failure(peb.error);
      pebs.push(peb.value);
    }
    const geometry = checkUbiPebs(measured.value, pebs);
    if (!geometry.ok) throw failure(geometry.error);
    const verifiedCopies = new Set<number>();
    for (const index of ubiCopiesToVerify(pebs)) {
      await setImmediate();
      this.#assertOpen(signal);
      const peb = pebs[index];
      if (peb?.state !== "mapped") continue;
      const data = await readArtifactFileBytes(
        handle,
        index * geometry.value.pebSize + geometry.value.dataOffset,
        peb.vid.dataSize,
        size,
        signal,
      );
      if (ubiCopyDataMatches(data, peb.vid)) verifiedCopies.add(index);
    }
    const tableBytes = ubiVolumeTableBytes(geometry.value);
    const copies: (Buffer | null)[] = [];
    for (const peb of ubiLayoutVolumePebs(pebs, verifiedCopies))
      copies.push(
        peb === null
          ? null
          : await readArtifactFileBytes(
              handle,
              peb * geometry.value.pebSize + geometry.value.dataOffset,
              tableBytes,
              size,
              signal,
            ),
      );
    const tableCopies = [copies[0] ?? null, copies[1] ?? null] as const;
    // A smaller size the LEBs or volume table rule out cannot begin an
    // eraseblock, so a header on only its grid is payload.
    const fit = ubiSmallerGridFit(measured.value, pebs, tableCopies);
    if (conflict !== null && next !== null) {
      const real = fit.plausible.has(conflict % next)
        ? conflict
        : await spacingConflict(fit.plausible);
      if (real !== null) throw parseFailure(ubiSpacingConflict(next, real));
    }
    // A valid header where an eraseblock of a smaller size would begin shows
    // the measured size skipped eraseblocks, wherever it lies in the image.
    if (fit.plausible.size > 0)
      for (
        let offset = 0, chunks = 0;
        offset < size;
        offset += SCAN_CHUNK_BYTES, chunks += 1
      ) {
        if (chunks % 16 === 0) await setImmediate();
        this.#assertOpen(signal);
        const header = findUbiSmallerGridHeader(
          await readArtifactFileBytes(
            handle,
            offset,
            Math.min(SCAN_CHUNK_BYTES + UBI_HEADER_BYTES, size - offset),
            size,
            signal,
          ),
          offset,
          first.value,
          measured.value,
          fit.plausible,
        );
        if (header !== null)
          throw parseFailure(
            ubiSpacingConflict(measured.value.pebSize, header),
          );
      }
    // Erased eraseblocks between headers fit a smaller size equally well; a
    // written byte at any of its off-grid header positions rules it out, as
    // does a LEB too large for it or a volume table invalid under it.
    for (const smaller of ubiSmallerPebSizes(measured.value)) {
      let fits = ubiSmallerPebSizeHoldsLebs(
        measured.value,
        pebs,
        smaller,
        tableCopies,
      );
      let probes = 0;
      for (
        let offset = smaller;
        fits && offset < size;
        offset += smaller, probes += 1
      ) {
        if (offset % measured.value.pebSize === 0) continue;
        if (probes % 256 === 0) await setImmediate();
        this.#assertOpen(signal);
        fits = ubiPebHeadersErased(
          await readArtifactFileBytes(
            handle,
            offset,
            measured.value.headerReadBytes,
            size,
            signal,
          ),
          measured.value,
        );
      }
      if (fits)
        throw parseFailure(ubiAmbiguousPebSize(measured.value, smaller));
    }
    const table = parseUbiVolumeTable(tableCopies, geometry.value);
    if (!table.ok) throw parseFailure(table.error);
    await this.#source.read(signal);
    this.#assertOpen(signal);
    const image = assembleUbiImage(
      geometry.value,
      pebs,
      table.value,
      verifiedCopies,
    );
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
            parserLimit.name === UBI_PEB_SIZE_LIMIT ? "bytes" : "eraseblocks",
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
