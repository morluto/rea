import type { FileHandle } from "node:fs/promises";
import {
  malformedInput,
  type ParseFailureError,
} from "../domain/parseFailure.js";

import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
} from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import type {
  AndroidBootImageEntryMetadata,
  AndroidBootImageMetadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import {
  absentAvbFooter,
  ANDROID_BOOT_FORMAT,
  ANDROID_BOOT_HEADER_PROBE_BYTES,
  ANDROID_BOOT_FIXED_LIMITS,
  AVB_FOOTER_SIZE,
  compressionFromPrefix,
  avbFooterOffset,
  inspectAvbFooter,
  parseAndroidBootHeader,
  parseVendorRamdiskTable,
  type AndroidBootComponentPlan,
  type AndroidBootCompression,
  type AndroidBootParse,
  type AvbFooterFacts,
  type VendorRamdiskTableParse,
} from "./AndroidBootImageFormat.js";

type BootEntry = PositionalArtifactEntry & {
  readonly formatMetadata: AndroidBootImageEntryMetadata;
};

const COMPRESSION_LIMITATION =
  "Compression was identified from the leading magic only and the stored bytes were not decompressed.";

/** Read an Android boot or vendor_boot image without unpacking or verifying it. */
export class AndroidBootImageArtifactReader extends PositionalArtifactReader<AndroidBootImageMetadata> {
  override readonly format = "android-boot-image" as const;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "Android boot image", admitted);
  }

  formatMetadata(): AndroidBootImageMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : { ...metadata };
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<AndroidBootImageMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const headerBytes = await readArtifactFileBytes(
      "android-boot-image",
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
    const tableResult = await this.#vendorTable(
      handle,
      initial.size,
      header,
      signal,
    );
    const plans = [
      ...(tableResult.table?.components ?? []),
      ...header.components,
    ];
    const footerResult = await this.#footer(
      handle,
      initial.size,
      header,
      plans,
      signal,
    );
    const compressions = await this.#compression(
      handle,
      initial.size,
      plans,
      signal,
    );
    const entries = new Map<string, BootEntry>();
    for (const plan of plans) {
      const entry = entryFor(plan, compressions.get(plan.path) ?? null);
      if (entries.has(entry.adapterKey))
        throw formatFailure(`duplicate component path ${plan.path}`);
      entries.set(entry.adapterKey, entry);
    }
    const degraded = tableResult.degraded || footerResult.degraded;
    return {
      entries: [...entries.values()],
      formatMetadata: toMetadata(header, footerResult.avb, plans.length),
      coverage: {
        status: degraded ? "unknown" : "complete",
        limitations: [
          ...header.limitations,
          ...(tableResult.table?.limitations ?? []),
          ...tableResult.limitations,
          ...footerResult.avb.limitations,
        ],
      },
    };
  }

  async #vendorTable(
    handle: Pick<FileHandle, "read">,
    fileSize: number,
    header: AndroidBootParse,
    signal?: AbortSignal,
  ): Promise<{
    readonly table: VendorRamdiskTableParse | undefined;
    readonly degraded: boolean;
    readonly limitations: readonly string[];
  }> {
    const range = header.tableRange;
    if (range === null)
      return { table: undefined, degraded: false, limitations: [] };
    const section = header.vendorRamdiskSection;
    if (
      section === null ||
      header.vendorRamdiskTableEntryCount === null ||
      header.vendorRamdiskTableEntrySize === null
    )
      throw formatFailure("vendor ramdisk table is missing its section");
    this.assertOpen(signal);
    const bytes = await readArtifactFileBytes(
      "android-boot-image",
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
    if (!table.ok) {
      const { failure } = table.error;
      if (
        failure.kind === "truncated" ||
        failure.kind === "limit" ||
        failure.field === "vendor_ramdisk_table_overlap"
      )
        throw parseFailure(table.error);
      return {
        table: undefined,
        degraded: true,
        limitations: [
          `Vendor ramdisk table could not be parsed: ${table.error.message}`,
        ],
      };
    }
    return { table: table.value, degraded: false, limitations: [] };
  }

  async #footer(
    handle: Pick<FileHandle, "read">,
    fileSize: number,
    header: AndroidBootParse,
    plans: readonly AndroidBootComponentPlan[],
    signal?: AbortSignal,
  ): Promise<{ readonly avb: AvbFooterFacts; readonly degraded: boolean }> {
    const offset = avbFooterOffset(fileSize, header.dataEnd);
    this.assertOpen(signal);
    const tail =
      offset !== null
        ? await readArtifactFileBytes(
            "android-boot-image",
            handle,
            offset,
            AVB_FOOTER_SIZE,
            fileSize,
            signal,
          )
        : null;
    const footer = inspectAvbFooter({
      fileSize,
      dataEnd: header.dataEnd,
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
    if (!footer.ok) {
      const { failure } = footer.error;
      if (
        failure.kind === "truncated" ||
        failure.kind === "limit" ||
        failure.field === "avb_overlap"
      )
        throw parseFailure(footer.error);
      return {
        avb: absentAvbFooter([
          `Optional trailing AVB footer could not be parsed: ${footer.error.message}`,
        ]),
        degraded: true,
      };
    }
    return { avb: footer.value, degraded: false };
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
        "android-boot-image",
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

/** A structural violation found while planning entries, with the format's own facts. */
const formatFailure = (detail: string): unknown =>
  artifactParseFailure(malformedInput(ANDROID_BOOT_FORMAT, detail), undefined);

const parseFailure = (failure: ParseFailureError): unknown => {
  const facts = failure.failure;
  if (facts.kind === "limit") {
    const ceiling = ANDROID_BOOT_FIXED_LIMITS.get(facts.limit.name);
    if (ceiling !== undefined)
      return artifactFixedLimitFailure(
        {
          name: ceiling.name,
          kind: "parser",
          limit: facts.limit.maximum,
          unit: ceiling.unit,
        },
        failure.message,
        "capacity",
        { cause: failure },
      );
  }
  return artifactParseFailure(failure, undefined, () => "capacity");
};

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
