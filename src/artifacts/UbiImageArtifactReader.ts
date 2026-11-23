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
  checkUbiPebs,
  classifyUbiPeb,
  judgeUbiPebCandidate,
  ubiCandidateGridOffsets,
  ubiVidMinPebSize,
  ubiHasMappedSecondPeb,
  ubiHasValidEcHeader,
  ubiPassedOverBoundaryProbes,
  ubiPebSizeCandidates,
  ubiFirstVidHeaderOffset,
  findUbiSpacingConflict,
  parseUbiFirstEcHeader,
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
  type UbiGeometry,
  type UbiImage,
  type UbiImageParseError,
  type UbiLebRange,
  type UbiPassedOverCandidate,
  type UbiPeb,
  type UbiPebCandidateVerdict,
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
    const spacingConflict = async (
      pebSize: number,
      candidates: ReadonlySet<number>,
    ): Promise<number | null> => {
      const { start, end } = ubiSpacingCheckRange(pebSize, size);
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
          pebSize,
          candidates,
        );
      }
      return found;
    };
    const findPassedOverBoundary = async (
      geometry: UbiGeometry,
      pebs: readonly UbiPeb[],
      passedOver: readonly UbiPassedOverCandidate[],
    ): Promise<number | null> => {
      let probes = 0;
      for (const candidate of passedOver) {
        for (const probe of ubiPassedOverBoundaryProbes(
          candidate,
          geometry,
          pebs,
          size,
        )) {
          if (probe.knownHeader) return probe.offset;
          if (probes % 256 === 0) await setImmediate();
          probes += 1;
          this.#assertOpen(signal);
          const bytes = await readArtifactFileBytes(
            handle,
            probe.offset,
            UBI_HEADER_BYTES,
            size,
            signal,
          );
          if (ubiHasValidEcHeader(bytes)) return probe.offset;
        }
      }
      return null;
    };
    const evaluateCandidate = async (
      candidate: number,
      passedOver: readonly UbiPassedOverCandidate[],
    ): Promise<UbiPebCandidateVerdict> => {
      const measured = ubiGeometry(first.value, candidate, size, null);
      if (!measured.ok) return { state: "reject", error: measured.error };
      const pebs: UbiPeb[] = [];
      let pebError: UbiImageParseError | null = null;
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
        if (peb.ok) {
          pebs.push(peb.value);
        } else {
          pebError ??= peb.error;
          pebs.push({ state: "corrupt", reason: peb.error.message, ec: null });
        }
      }
      let geometry = measured.value;
      if (pebError === null) {
        const checked = checkUbiPebs(measured.value, pebs);
        if (checked.ok) geometry = checked.value;
        else pebError = checked.error;
      }
      const verifiedCopies = new Set<number>();
      for (const index of ubiCopiesToVerify(pebs)) {
        await setImmediate();
        this.#assertOpen(signal);
        const peb = pebs[index];
        if (peb?.state !== "mapped") continue;
        const data = await readArtifactFileBytes(
          handle,
          index * geometry.pebSize + geometry.dataOffset,
          peb.vid.dataSize,
          size,
          signal,
        );
        if (ubiCopyDataMatches(data, peb.vid)) verifiedCopies.add(index);
      }
      const tableBytes = ubiVolumeTableBytes(geometry);
      const copies: (Buffer | null)[] = [];
      for (const peb of ubiLayoutVolumePebs(pebs, verifiedCopies))
        copies.push(
          peb === null
            ? null
            : await readArtifactFileBytes(
                handle,
                peb * geometry.pebSize + geometry.dataOffset,
                tableBytes,
                size,
                signal,
              ),
        );
      const tableCopies = [copies[0] ?? null, copies[1] ?? null] as const;
      // A smaller size the LEBs or volume table rule out cannot begin an
      // eraseblock, so a header on only its grid is payload.
      const fit = ubiSmallerGridFit(measured.value, pebs, tableCopies);
      let smallerGridError: UbiImageParseError | null = null;
      // A valid header where an eraseblock of a smaller size would begin shows
      // the measured size skipped eraseblocks, wherever it lies in the image.
      if (fit.plausible.size > 0)
        for (
          let offset = 0, chunks = 0;
          smallerGridError === null && offset < size;
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
            smallerGridError = ubiSpacingConflict(
              measured.value.pebSize,
              header,
            );
        }
      // Erased eraseblocks between headers fit a smaller size equally well; a
      // written byte at any of its off-grid header positions rules it out, as
      // does a LEB too large for it or a volume table invalid under it.
      if (smallerGridError === null)
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
          if (fits) {
            smallerGridError = ubiAmbiguousPebSize(measured.value, smaller);
            break;
          }
        }
      const passedOverHeaderOffset =
        smallerGridError === null &&
        pebError === null &&
        (tableCopies[0] !== null || tableCopies[1] !== null) &&
        passedOver.length > 0
          ? await findPassedOverBoundary(geometry, pebs, passedOver)
          : null;
      return judgeUbiPebCandidate({
        geometry,
        pebs,
        tableCopies,
        verifiedCopies,
        pebError,
        smallerGridError,
        passedOverHeaderOffset,
      });
    };
    type PendingFailure =
      | { readonly kind: "error"; readonly error: UbiImageParseError }
      | { readonly kind: "non-dividing"; readonly candidate: number };
    const resolveFailure = async (
      failure: PendingFailure,
    ): Promise<UbiImageParseError> => {
      if (failure.kind === "error") return failure.error;
      const conflict = await spacingConflict(
        failure.candidate,
        ubiCandidateGridOffsets(failure.candidate, first.value.dataOffset),
      );
      const measured = ubiGeometry(
        first.value,
        failure.candidate,
        size,
        conflict,
      );
      if (!measured.ok) return measured.error;
      throw formatFailure("UBI image eraseblock size could not be determined");
    };
    // Keep dividing candidates provisional until the volume table, LEB, and
    // passed-over boundary constraints agree. Non-dividing mapped second PEBs
    // also stay provisional as passed-over boundaries: a later dividing
    // candidate may accept only if it places every passed-over header inside
    // mapped non-layout LEB data; otherwise the first failure stands.
    let accepted: UbiImage | null = null;
    let anyNext: number | null = null;
    let firstFailure: PendingFailure | null = null;
    const passedOver: UbiPassedOverCandidate[] = [];
    let lastCandidate = 0;
    for (
      let offset = ubiPebSearchStart(first.value);
      accepted === null && offset < scanEnd;
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
        if (candidate <= lastCandidate) continue;
        lastCandidate = candidate;
        anyNext ??= candidate;
        if (size % candidate === 0) {
          const verdict = await evaluateCandidate(candidate, passedOver);
          if (verdict.state === "accept") {
            accepted = verdict.image;
            break;
          }
          if (verdict.state === "reject")
            throw parseFailure(
              firstFailure === null
                ? verdict.error
                : await resolveFailure(firstFailure),
            );
          firstFailure ??= { kind: "error", error: verdict.error };
          passedOver.push({ offset: candidate, dividing: true });
          continue;
        }
        const candidateVid = candidate + first.value.vidHeaderOffset;
        if (
          candidateVid + UBI_HEADER_BYTES <= size &&
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
          )
        ) {
          firstFailure ??= { kind: "non-dividing", candidate };
          passedOver.push({ offset: candidate, dividing: false });
        }
      }
    }
    if (accepted === null) {
      if (firstFailure !== null)
        throw parseFailure(await resolveFailure(firstFailure));
      const conflict =
        anyNext === null
          ? null
          : await spacingConflict(
              anyNext,
              ubiCandidateGridOffsets(anyNext, first.value.dataOffset),
            );
      const measured = ubiGeometry(first.value, anyNext, size, conflict);
      if (!measured.ok) throw parseFailure(measured.error);
      throw formatFailure("UBI image eraseblock size could not be determined");
    }
    await this.#source.read(signal);
    this.#assertOpen(signal);
    const image = accepted;
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
