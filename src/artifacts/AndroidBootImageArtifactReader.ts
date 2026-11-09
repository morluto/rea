import { Readable, Transform, pipeline } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import type {
  AndroidBootImageEntryMetadata,
  AndroidBootImageMetadata,
} from "../domain/artifactFormatMetadata.js";
import {
  ANDROID_BOOT_HEADER_PROBE_BYTES,
  AVB_FOOTER_SIZE,
  compressionFromPrefix,
  inspectAvbFooter,
  parseAndroidBootHeader,
  parseVendorRamdiskTable,
  type AndroidBootComponentPlan,
  type AndroidBootCompression,
  type AndroidBootParse,
  type AndroidBootParseError,
  type AvbFooterFacts,
  type VendorRamdiskTableParse,
} from "../domain/androidBootImageFormat.js";

type BootEntry = ArtifactEntry & {
  readonly byteOffset: number;
  readonly declaredSize: number;
  readonly formatMetadata: AndroidBootImageEntryMetadata;
};

const COMPRESSION_LIMITATION =
  "Compression was identified from the leading magic only and the stored bytes were not decompressed.";

/** Read an Android boot or vendor_boot image without unpacking or verifying it. */
export class AndroidBootImageArtifactReader implements ArtifactReader {
  readonly format = "android-boot-image" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, BootEntry>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  #prepared: Promise<void> | undefined;
  #header: AndroidBootImageMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "Android boot image", admitted);
  }

  formatMetadata(): AndroidBootImageMetadata | undefined {
    return this.#header === undefined ? undefined : { ...this.#header };
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
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    options?.onCoverage?.({
      status: "complete",
      limitations: [...this.#limitations],
    });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          "Android boot image entry does not match its owning inventory",
        );
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
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
                  "Android boot image read cancelled",
                  { cause: reason },
                ),
            });
      const output = this.#memberStream(stored, signal);
      output.on("error", () => undefined);
      this.#streams.add(output);
      let producerComplete = false;
      const onAbort = (): void => {
        if (!producerComplete || output.destroyed) return;
        output.destroy(
          new ArtifactReaderFailure(
            "cancelled",
            "Android boot image read cancelled",
            { cause: signal?.reason },
          ),
        );
      };
      const retired = new Promise<void>((resolve) => {
        output.once("close", () => {
          this.#streams.delete(output);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void this.#scope
        .run(async () => {
          await Promise.all([
            new Promise<void>((resolve) =>
              pipeline(source, output, () => {
                producerComplete = true;
                if (signal?.aborted) onAbort();
                resolve();
              }),
            ),
            retired,
          ]);
        })
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error("Android boot image stream ownership failed", {
                  cause,
                }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure(
          "unavailable",
          "Android boot image reader closed",
        ),
      );
    await this.#scope.close();
    await this.#source.close();
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
        "Android boot image reader closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const headerBytes = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, ANDROID_BOOT_HEADER_PROBE_BYTES),
      initial.size,
      signal,
    );
    this.#assertOpen(signal);
    const parsed = parseAndroidBootHeader(headerBytes, initial.size);
    if (!parsed.ok) throw parseFailure(parsed.error);
    const header = parsed.value;
    const table = await this.#vendorTable(handle, initial.size, header, signal);
    const plans = [...(table?.components ?? []), ...header.components];
    const avb = await this.#footer(handle, initial.size, header, plans, signal);
    const compressions = await this.#compression(
      handle,
      initial.size,
      plans,
      signal,
    );
    this.#header = toMetadata(header, avb, plans.length);
    this.#limitations = [
      ...header.limitations,
      ...(table?.limitations ?? []),
      ...avb.limitations,
    ];
    for (const plan of plans) {
      const entry = entryFor(plan, compressions.get(plan.path) ?? null);
      if (this.#entries.has(entry.adapterKey))
        throw formatFailure(`duplicate component path ${plan.path}`);
      this.#entries.set(entry.adapterKey, entry);
    }
  }

  async #vendorTable(
    handle: Pick<FileHandle, "read">,
    fileSize: number,
    header: AndroidBootParse,
    signal?: AbortSignal,
  ): Promise<VendorRamdiskTableParse | undefined> {
    const range = header.tableRange;
    if (range === null) return undefined;
    const section = header.vendorRamdiskSection;
    if (
      section === null ||
      header.vendorRamdiskTableEntryCount === null ||
      header.vendorRamdiskTableEntrySize === null
    )
      throw formatFailure("vendor ramdisk table is missing its section");
    this.#assertOpen(signal);
    const bytes = await readArtifactFileBytes(
      handle,
      range.offset,
      range.size,
      fileSize,
      signal,
    );
    const table = parseVendorRamdiskTable(bytes, {
      entryCount: header.vendorRamdiskTableEntryCount,
      entrySize: header.vendorRamdiskTableEntrySize,
      sectionOffset: section.offset,
      sectionSize: section.size,
      ramdiskAddr: header.ramdiskAddr,
    });
    if (!table.ok) throw parseFailure(table.error);
    return table.value;
  }

  async #footer(
    handle: Pick<FileHandle, "read">,
    fileSize: number,
    header: AndroidBootParse,
    plans: readonly AndroidBootComponentPlan[],
    signal?: AbortSignal,
  ): Promise<AvbFooterFacts> {
    const trailing = fileSize - header.imageEnd;
    this.#assertOpen(signal);
    const tail =
      trailing >= AVB_FOOTER_SIZE
        ? await readArtifactFileBytes(
            handle,
            fileSize - AVB_FOOTER_SIZE,
            AVB_FOOTER_SIZE,
            fileSize,
            signal,
          )
        : null;
    const footer = inspectAvbFooter({
      fileSize,
      imageEnd: header.imageEnd,
      headerOccupied: header.headerOccupied,
      components: [
        ...plans,
        ...(header.tableRange === null ? [] : [header.tableRange]),
        ...(header.vendorRamdiskSection !== null &&
        header.vendorRamdiskSection.size > 0
          ? [header.vendorRamdiskSection]
          : []),
      ],
      tail,
    });
    if (!footer.ok) throw parseFailure(footer.error);
    return footer.value;
  }

  async #compression(
    handle: Pick<FileHandle, "read">,
    fileSize: number,
    plans: readonly AndroidBootComponentPlan[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, AndroidBootCompression | null>> {
    const observed = new Map<string, AndroidBootCompression | null>();
    for (const plan of plans) {
      this.#assertOpen(signal);
      const prefix = await readArtifactFileBytes(
        handle,
        plan.offset,
        Math.min(4, plan.size),
        fileSize,
        signal,
      );
      observed.set(plan.path, compressionFromPrefix(prefix));
    }
    return observed;
  }

  #memberStream(entry: BootEntry, signal?: AbortSignal): Transform {
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize)
        throw formatFailure(`member ended early: ${entry.path}`);
      await this.#source.read(signal);
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
                : new Error("Android boot image read failed", { cause }),
            ),
        );
      },
    });
  }
}

const formatFailure = (
  detail: string,
  options?: ErrorOptions,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Android boot image is malformed: ${detail}`,
    options,
  );

const parseFailure = (failure: AndroidBootParseError): ArtifactReaderFailure =>
  failure._tag === "AndroidBootCapacityFailure"
    ? artifactFixedLimitFailure(
        failure.limit.name,
        failure.limit.maximum,
        failure.limit.unit,
      )
    : formatFailure(failure.message, { cause: failure });

const entryFor = (
  plan: AndroidBootComponentPlan,
  compression: AndroidBootCompression | null,
): BootEntry => ({
  path: plan.path,
  kind: "file",
  declaredSize: plan.size,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: plan.offset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: compression === null ? [] : [COMPRESSION_LIMITATION],
  adapterKey: `android-boot-image:${plan.path}`,
  formatMetadata: {
    kind: "android-boot-image-entry",
    role: plan.role,
    index: plan.index,
    compression,
    ramdisk_type: plan.ramdiskType,
    ramdisk_type_name: plan.ramdiskTypeName,
    load_address: plan.loadAddress,
    name_bytes_hex: plan.nameBytesHex,
    board_id_hex: plan.boardIdHex,
  },
  sourcePath: plan.path,
});

const toMetadata = (
  header: AndroidBootParse,
  avb: AvbFooterFacts,
  componentCount: number,
): AndroidBootImageMetadata => ({
  kind: "android-boot-image",
  image_kind: header.imageKind,
  magic: header.magic,
  header_version: header.headerVersion,
  page_size: header.pageSize,
  header_size: header.headerSize,
  os_version_raw: header.osVersionRaw,
  os_version: header.osVersion,
  security_patch_level: header.securityPatchLevel,
  name: header.name,
  name_bytes_hex: header.nameBytesHex,
  cmdline: header.cmdline,
  cmdline_bytes_hex: header.cmdlineBytesHex,
  extra_cmdline: header.extraCmdline,
  extra_cmdline_bytes_hex: header.extraCmdlineBytesHex,
  command_line: header.commandLine,
  header_digest_hex: header.headerDigestHex,
  kernel_addr: header.kernelAddr,
  ramdisk_addr: header.ramdiskAddr,
  second_addr: header.secondAddr,
  tags_addr: header.tagsAddr,
  dtb_addr: header.dtbAddr,
  kernel_size: header.kernelSize,
  ramdisk_size: header.ramdiskSize,
  second_size: header.secondSize,
  recovery_dtbo_size: header.recoveryDtboSize,
  recovery_dtbo_offset: header.recoveryDtboOffset,
  dtb_size: header.dtbSize,
  signature_size: header.signatureSize,
  vendor_ramdisk_size: header.vendorRamdiskSize,
  vendor_ramdisk_table_entry_count: header.vendorRamdiskTableEntryCount,
  vendor_ramdisk_table_entry_size: header.vendorRamdiskTableEntrySize,
  bootconfig_size: header.bootconfigSize,
  avb_footer_present: avb.present,
  avb_footer_size: avb.footerSize,
  avb_version_major: avb.versionMajor,
  avb_version_minor: avb.versionMinor,
  avb_original_image_size: avb.originalImageSize,
  avb_vbmeta_offset: avb.vbmetaOffset,
  avb_vbmeta_size: avb.vbmetaSize,
  component_count: componentCount,
});
