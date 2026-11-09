import type { FileHandle } from "node:fs/promises";

import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
} from "./ArtifactReader.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
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

type BootEntry = PositionalArtifactEntry & {
  readonly formatMetadata: AndroidBootImageEntryMetadata;
};

const COMPRESSION_LIMITATION =
  "Compression was identified from the leading magic only and the stored bytes were not decompressed.";

/** Read an Android boot or vendor_boot image without unpacking or verifying it. */
export class AndroidBootImageArtifactReader extends PositionalArtifactReader {
  override readonly format = "android-boot-image" as const;
  #header: AndroidBootImageMetadata | undefined;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "Android boot image", admitted);
  }

  formatMetadata(): AndroidBootImageMetadata | undefined {
    return this.#header === undefined ? undefined : { ...this.#header };
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const headerBytes = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, ANDROID_BOOT_HEADER_PROBE_BYTES),
      initial.size,
      signal,
    );
    this.assertOpen(signal);
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
    const entries = new Map<string, BootEntry>();
    for (const plan of plans) {
      const entry = entryFor(plan, compressions.get(plan.path) ?? null);
      if (entries.has(entry.adapterKey))
        throw formatFailure(`duplicate component path ${plan.path}`);
      entries.set(entry.adapterKey, entry);
    }
    return {
      entries: [...entries.values()],
      coverage: {
        status: "complete",
        limitations: [
          ...header.limitations,
          ...(table?.limitations ?? []),
          ...avb.limitations,
        ],
      },
    };
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
    this.assertOpen(signal);
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
    this.assertOpen(signal);
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
      this.assertOpen(signal);
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
