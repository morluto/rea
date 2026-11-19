import { lstat } from "node:fs/promises";
import { Readable } from "node:stream";

import { Budget } from "../domain/budget.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { readFfsHeader, type FfsPaddingRange } from "./FfsFile.js";
import {
  inspectFirmwareVolumeExtension,
  scanFirmwareVolumes,
  unsupportedVolumeBodyReason,
  type FirmwareVolumeHeader,
} from "./FirmwareVolume.js";
import { imageRegion } from "./UefiBytes.js";
import {
  ArtifactReaderFailure,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
  assertArtifactReadActive,
  readArtifactFileChunks,
  streamChunkToBuffer,
} from "../resources/index.js";

const hex = (value: number): string => `0x${value.toString(16)}`;
const volumePath = (offset: number): string => `firmware-volume-${hex(offset)}`;

const IMAGE_TRUNCATION_LIMITATION =
  `The image exceeds the ${UEFI_FIRMWARE_LIMITS.inputBytes}-byte admission budget; ` +
  "only the leading admission window is mapped.";

const volumeLimitation = (header: FirmwareVolumeHeader): string =>
  header.fileSystem === "unsupported"
    ? unsupportedVolumeBodyReason(header)
    : `Firmware volume at ${hex(header.absoluteBase)} declares PI firmware file system ${header.fileSystem === "ffs2" ? "2 (FFS2)" : "3 (FFS3)"}; inspect_uefi_firmware maps its sections and compression.`;

/** Read-only FV/FFS level adapter over one PI flash image. */
export class UefiArtifactReader implements ArtifactReader {
  readonly format = "uefi" as const;
  #source: StableRegularFileDescriptor | undefined;
  #ownedSource: OwnedFileHandle | undefined;
  #pendingSource: Promise<StableRegularFileDescriptor> | undefined;
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #ownsSource: boolean;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly path: string,
    source?: StableRegularFileDescriptor,
  ) {
    this.#source = source;
    this.#ownsSource = source === undefined;
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    const source = await this.#ensureSource();
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "UEFI flash image reader is closed",
      );
    await this.#verifySource(source);
    if (signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "UEFI entry scan cancelled",
        {
          cause: signal.reason,
        },
      );
    this.#entries.clear();
    const image = await this.#readImage(source, signal);
    const limitations = new Set<string>();
    const omit = (path: string, limitation: string): void => {
      options?.onOmission?.({ path, kind: "unsupported" });
      limitations.add(limitation);
    };
    const imageTruncated = source.initial.size > image.length;
    if (imageTruncated) omit("image-truncated", IMAGE_TRUNCATION_LIMITATION);
    const region = imageRegion(image, 0, image.length);
    const records = new Budget(UEFI_FIRMWARE_LIMITS.scanRecords);
    const checkpoint = () => assertArtifactReadActive(signal);
    const reserve = (): boolean => {
      checkpoint();
      return records.tryCharge(1);
    };
    const scan = scanFirmwareVolumes(region, UEFI_FIRMWARE_LIMITS.maxVolumes, {
      reserve,
    });
    if (scan.limit !== null) {
      omit(
        "volume-scan-limit",
        scan.limit === "structural-records"
          ? `UEFI volume search reached the structural record limit of ${UEFI_FIRMWARE_LIMITS.scanRecords}.`
          : "UEFI volume search reached its candidate limit.",
      );
    }
    for (const { absoluteBase, truncation } of scan.rejected) {
      if (truncation === undefined) continue;
      omit(
        volumePath(absoluteBase),
        `Firmware volume at ${hex(absoluteBase)} is truncated: declared ${truncation.declaredLength} bytes, observed ${truncation.observedLength}.`,
      );
    }
    let filesMapped = 0;
    let fileBudgetExhausted = false;
    for (const hit of scan.volumes) {
      const header = hit.header;
      const name = volumePath(header.absoluteBase);
      const entry: ArtifactEntry = {
        path: name,
        kind: "directory",
        declaredSize: header.declaredLength,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: header.absoluteBase,
        declaredIntegrity: null,
        unpacked: true,
        limitations: [
          volumeLimitation(header),
          ...(imageTruncated && hit === scan.volumes[0]
            ? [IMAGE_TRUNCATION_LIMITATION]
            : []),
        ],
        adapterKey: name,
      };
      this.#entries.set(entry.adapterKey, entry);
      yield entry;
      let observedFileEnd: number | undefined;
      if (header.fileSystem === "unsupported") {
        omit(
          name,
          "Volumes with unsupported file-system GUIDs were retained without FFS entries.",
        );
      } else {
        for await (const file of this.#volumeFiles(header, image, name, {
          omit,
          reserve,
          checkpoint,
        })) {
          if (filesMapped >= UEFI_FIRMWARE_LIMITS.maxFiles) {
            fileBudgetExhausted = true;
            break;
          }
          this.#entries.set(file.adapterKey, file);
          filesMapped += 1;
          if (file.byteOffset !== null && file.declaredSize !== null)
            observedFileEnd = file.byteOffset + file.declaredSize;
          yield file;
        }
      }
      for (const issue of inspectFirmwareVolumeExtension(
        region,
        header,
        reserve,
        checkpoint,
        observedFileEnd,
      )) {
        omit(`${name}/fv-extension-${hex(issue.offset)}`, issue.detail);
      }
      if (fileBudgetExhausted) {
        omit(name, "UEFI inventory reached its FFS file limit.");
        break;
      }
    }
    options?.onCoverage?.({
      status: limitations.size === 0 ? "complete" : "unknown",
      limitations: [...limitations],
    });
  }

  /** One FFS file occurrence per parseable header; erased tails end the walk. */
  async *#volumeFiles(
    header: FirmwareVolumeHeader,
    image: Buffer,
    volumeName: string,
    {
      omit,
      reserve,
      checkpoint,
    }: {
      omit: (path: string, limitation: string) => void;
      reserve: () => boolean;
      checkpoint: () => void;
    },
  ): AsyncGenerator<ArtifactEntry> {
    const region = imageRegion(
      image,
      header.absoluteBase,
      Math.min(header.absoluteBase + header.declaredLength, image.length),
    );
    const omitPadding = ({ offset, length }: FfsPaddingRange): void =>
      omit(
        `${volumeName}/ffs-padding-${hex(offset)}`,
        `Unexpected FFS alignment bytes at ${hex(offset)}: ${length} bytes.`,
      );
    for (const padding of header.filePrefixPadding) omitPadding(padding);
    let local = header.firstFileLocal;
    while (local < region.end) {
      checkpoint();
      const read = readFfsHeader(region, local, header.erasePolarity, reserve);
      if (read.kind === "limited") {
        omit(
          `${volumeName}/ffs-scan-limit-${hex(local)}`,
          `UEFI inventory reached the structural record limit of ${UEFI_FIRMWARE_LIMITS.scanRecords} before the FFS header at ${hex(local)}.`,
        );
        break;
      }
      if (read.kind === "unusable-header") {
        omit(`${volumeName}/ffs-header-${hex(read.offset)}`, read.detail);
        local = read.nextLocal;
        continue;
      }
      if (read.kind === "unparsed") {
        omit(
          `${volumeName}/ffs-suffix-${hex(read.offset)}`,
          read.detail ??
            `Unparsed FFS suffix at ${hex(read.offset)}: ${read.length} bytes.`,
        );
      }
      if (read.kind !== "file") break;
      const fileHeader = read.header;
      const name =
        fileHeader.nameGuid === null
          ? `${volumeName}/ffs-file-${hex(fileHeader.absoluteBase)}.bin`
          : `${volumeName}/ffs-file-${fileHeader.nameGuid}.bin`;
      const entry: ArtifactEntry = {
        path: name,
        kind: "file",
        declaredSize: fileHeader.observedLength,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: fileHeader.absoluteBase,
        declaredIntegrity: null,
        unpacked: true,
        limitations: [
          "FFS file sections and nested compression are not expanded by the session inventory reader; inspect_uefi_firmware maps them.",
          ...(fileHeader.implausibilities.length > 0
            ? [
                `FFS header implausibility at ${hex(fileHeader.absoluteBase)}: ${fileHeader.implausibilities.join(", ")}.`,
              ]
            : []),
        ],
        adapterKey: `uefi-ffs:${hex(fileHeader.absoluteBase)}`,
      };
      if (fileHeader.extentIssue !== null)
        omit(
          name,
          `Incomplete FFS extent at ${hex(fileHeader.absoluteBase)}: declared ${fileHeader.declaredLength} bytes, observed ${fileHeader.observedLength} (${fileHeader.extentIssue}).`,
        );
      if (
        fileHeader.bodyIssue !== null &&
        fileHeader.body !== null &&
        fileHeader.body.start < fileHeader.body.end
      )
        omit(
          name,
          `FFS file at ${hex(fileHeader.absoluteBase)} has a valid header but its data is not marked valid.`,
        );
      yield entry;
      if (read.padding !== null) omitPadding(read.padding);
      local = read.nextLocal;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    if (signal?.aborted === true)
      return Promise.reject(
        new ArtifactReaderFailure(
          "cancelled",
          "UEFI flash image read cancelled",
          { cause: signal.reason },
        ),
      );
    const produced = this.#entries.get(entry.adapterKey);
    if (produced === undefined || !sameArtifactEntry(entry, produced))
      throw new ArtifactReaderFailure(
        "integrity",
        "UEFI flash image entry metadata does not match this reader's inventory",
        { integrityCheck: "foreign-entry" },
      );
    const offset = produced.byteOffset;
    const size = produced.declaredSize;
    if (
      offset === null ||
      size === null ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size <= 0
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Invalid UEFI FFS byte range: ${entry.path}`,
        { integrityCheck: "entry-metadata" },
      );
    const source = await this.#ensureSource();
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "UEFI flash image reader is closed",
      );
    await this.#verifySource(source);
    if (
      !Number.isSafeInteger(offset + size) ||
      offset + size > source.initial.size
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `UEFI FFS range is outside the artifact: ${entry.path}`,
        { integrityCheck: "entry-metadata" },
      );
    const sourceStream = readArtifactFileChunks(source.handle, {
      start: offset,
      end: offset + size - 1,
      ...(signal === undefined ? {} : { signal }),
    });
    const verifySource = () => this.#verifySource(source);
    const completionFailure = (): ArtifactReaderFailure | undefined => {
      const coverage = sourceStream.readCoverage();
      if (coverage.kind !== "complete")
        return new ArtifactReaderFailure(
          "integrity",
          `UEFI FFS read coverage is incomplete: ${entry.path}`,
          { integrityCheck: "declared-size" },
        );
      if (coverage.bytes !== BigInt(size))
        return new ArtifactReaderFailure(
          "integrity",
          `UEFI FFS size disagrees with the mapped header: ${entry.path}`,
          { integrityCheck: "declared-size" },
        );
      if (signal?.aborted)
        return new ArtifactReaderFailure(
          "cancelled",
          "UEFI flash image read cancelled",
          { cause: signal.reason },
        );
      return undefined;
    };
    const output = Readable.from(
      (async function* () {
        for await (const raw of sourceStream) {
          yield streamChunkToBuffer(raw);
        }
        const failure = completionFailure();
        if (failure !== undefined) throw failure;
        await verifySource();
        assertArtifactReadActive(signal);
      })(),
    );
    const onSourceError = (cause: unknown): void => {
      output.destroy(
        cause instanceof ArtifactReaderFailure
          ? cause
          : new ArtifactReaderFailure(
              "integrity",
              `Could not read UEFI FFS range: ${entry.path}`,
              { cause, integrityCheck: "container-identity" },
            ),
      );
    };
    sourceStream.on("error", onSourceError);
    sourceStream.once("close", () =>
      sourceStream.removeListener("error", onSourceError),
    );
    output.once("close", () => {
      if (!sourceStream.destroyed) sourceStream.destroy();
    });
    return output;
  }

  provenance(): readonly ArtifactCommand[] {
    // A pure TypeScript parser runs no native commands.
    return [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= this.#closeSource().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  async #closeSource(): Promise<void> {
    await this.#pendingSource?.catch(() => undefined);
    if (!this.#ownsSource || this.#ownedSource === undefined) return;
    try {
      await this.#ownedSource.close();
      this.#ownedSource = undefined;
      this.#source = undefined;
    } catch (cause: unknown) {
      throw ArtifactReaderFailure.withCleanup(
        cause,
        ArtifactReaderFailure.cleanupObservation(cause, this.path),
      );
    }
  }

  async #ensureSource(): Promise<StableRegularFileDescriptor> {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "UEFI flash image reader is closed",
      );
    if (this.#source !== undefined) return this.#source;
    this.#pendingSource ??= this.#acquireSource();
    const source = await this.#pendingSource;
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "UEFI flash image reader closed during source acquisition",
      );
    return source;
  }

  async #acquireSource(): Promise<StableRegularFileDescriptor> {
    let source: StableRegularFileDescriptor;
    try {
      source = await openRegularFile(this.path, { symlinks: "reject" });
    } catch (cause: unknown) {
      if (!(cause instanceof RegularFileAdmissionFailure)) throw cause;
      this.#ownedSource = cause.owner;
      const primary =
        cause.cause instanceof NonRegularFileReadError
          ? new ArtifactReaderFailure(
              "format",
              `UEFI flash image source is not a regular file: ${this.path}`,
              { cause: cause.cause },
            )
          : cause.cause;
      throw ArtifactReaderFailure.withCleanup(
        primary,
        ArtifactReaderFailure.cleanupObservation(cause.cleanupCause, this.path),
      );
    }
    this.#ownedSource = new OwnedFileHandle(source.handle);
    this.#source = source;
    return source;
  }

  async #verifySource(source: StableRegularFileDescriptor): Promise<void> {
    const [opened, currentPath] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, currentPath)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `UEFI flash image source changed during inventory: ${this.path}`,
        { integrityCheck: "container-identity" },
      );
  }

  /** Whole-image read bounded by the admission limit; the parsers need bytes. */
  async #readImage(
    source: StableRegularFileDescriptor,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(
      Math.min(UEFI_FIRMWARE_LIMITS.inputBytes, source.initial.size),
    );
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      if (signal?.aborted === true)
        throw new ArtifactReaderFailure(
          "cancelled",
          "UEFI flash image read cancelled",
          { cause: signal.reason },
        );
      const read = await source.handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "io",
          `UEFI flash image truncated during read: ${this.path}`,
        );
      bytesRead += read.bytesRead;
    }
    return buffer;
  }
}
