import type { FileHandle } from "node:fs/promises";

import type { EspFlashImageMetadata } from "../domain/artifactFormatMetadata.js";
import { ESP_CHIP_TABLE_SOURCE } from "../domain/firmware/espChips.js";
import {
  espErasedSlotLimitation,
  espFlashPartitionFacts,
  finishEspFlashLayout,
  planEspFlashLayout,
  type EspFlashLayoutFacts,
  type EspFlashPlan,
  type EspFlashRegion,
  type EspFlashWrittenExtent,
} from "../domain/firmware/espFlashLayout.js";
import {
  locateEspFlashLayout,
  type EspFlashLocation,
  type EspFlashSelection,
} from "../domain/firmware/espFlashLocation.js";
import { offsetText } from "../domain/firmware/espImageStructures.js";
import { ESP_OTA_SELECT_ENTRY_BYTES } from "../domain/firmware/espOtaData.js";
import { isEspAppPartition } from "../domain/firmware/espPartitionTable.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  decodeEspFlashImage,
  firstUnerasedInRange,
  readEspFlashRange,
  writtenExtents,
  type EspFlashReadContext,
} from "./EspFlashRegionReads.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

const LABEL = "ESP flash image";

/** A located layout borrowed with the descriptor that produced it. */
export interface EspFlashAdmission {
  readonly kind: "esp-flash-image";
  readonly source: StableRegularFileDescriptor;
  readonly location: EspFlashLocation;
}

type EspFlashImageFacts = NonNullable<
  EspFlashImageMetadata["bootloader"]
>["facts"];

/**
 * Inventory an ESP flash dump as its bootloader region, partition table and
 * partitions. The bootloader and app partitions are decoded as ESP images;
 * each entry is a positional read of the carrier, rechecked against its
 * identity.
 */
export class EspFlashImageArtifactReader extends PositionalArtifactReader {
  override readonly format = "esp-flash-image" as const;
  readonly #located: EspFlashLocation | undefined;
  readonly #selection: EspFlashSelection;
  #metadata: EspFlashImageMetadata | undefined;

  constructor(
    path: string,
    admitted?: EspFlashAdmission | StableRegularFileDescriptor,
    selection: EspFlashSelection = {},
  ) {
    const admission =
      admitted !== undefined && "kind" in admitted ? admitted : undefined;
    super(
      path,
      LABEL,
      admission?.source ??
        (admitted as StableRegularFileDescriptor | undefined),
    );
    this.#located = admission?.location;
    this.#selection = selection;
  }

  formatMetadata(): EspFlashImageMetadata | undefined {
    return this.#metadata === undefined
      ? undefined
      : structuredClone(this.#metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const fileSize = initial.size;
    const location =
      this.#located ?? (await this.#locate(handle, fileSize, signal));
    const plan = planEspFlashLayout({
      fileSize,
      origin: location.origin,
      bootloader: location.bootloader,
      tableAddress: location.tableAddress,
      tableMethod: location.tableMethod,
      table: location.table,
    });
    const context: EspFlashReadContext = { handle, fileSize, signal };
    const facts = await this.#readFacts(context, plan);
    const images = await this.#decodeImages(context, plan);
    const written = await this.#readWritten(context, plan);
    // A changed carrier is an identity failure, not a different layout.
    await this.verifyCarrier(signal);
    this.#metadata = layoutMetadata(location, plan, facts, images);
    const limitations = [
      ...location.limitations,
      ...(location.tableMethod === "scan"
        ? [
            `The partition table at ${offsetText(location.tableAddress)} was found by scanning 0x1000-aligned flash sectors for a table whose MD5 verifies; the dump does not record the bootloader's configured table offset.`,
          ]
        : []),
      ...facts.limitations,
      ...erasedSlotLimitations(images, written),
    ];
    return {
      entries: plan.regions.map((region) =>
        regionEntry(region, written.get(region), fileSize),
      ),
      coverage:
        facts.coverage === "unknown" || limitations.length > 0
          ? { status: facts.coverage, limitations }
          : undefined,
    };
  }

  async #locate(
    handle: FileHandle,
    fileSize: number,
    signal?: AbortSignal,
  ): Promise<EspFlashLocation> {
    const located = await locateEspFlashLayout(
      fileSize,
      (position, length) =>
        readEspFlashRange({ handle, fileSize, signal }, position, length),
      this.#selection,
      { explicit: true, ...(signal === undefined ? {} : { signal }) },
    );
    if (!located.ok)
      throw new ArtifactReaderFailure(
        "unavailable",
        `${LABEL} layout is not recognized: ${located.error}`,
      );
    return located.value;
  }

  async #readFacts(
    context: EspFlashReadContext,
    plan: EspFlashPlan,
  ): Promise<EspFlashLayoutFacts> {
    const otadataRecords: (Uint8Array | undefined)[] = [];
    for (const { fileOffset, available } of plan.otadata?.records ?? [])
      otadataRecords.push(
        available
          ? await readEspFlashRange(
              context,
              fileOffset,
              ESP_OTA_SELECT_ENTRY_BYTES,
            )
          : undefined,
      );
    const gapFirstUnerased: (number | undefined)[] = [];
    for (const gap of plan.gaps) {
      this.assertOpen(context.signal);
      gapFirstUnerased.push(
        await firstUnerasedInRange(
          context,
          { start: gap.offset, length: gap.length },
          () => this.assertOpen(context.signal),
        ),
      );
    }
    return finishEspFlashLayout(plan, { otadataRecords, gapFirstUnerased });
  }

  /**
   * Where each partition the dump holds is not erased flash, from one read
   * of the bytes the partitions cover, however many overlap.
   */
  async #readWritten(
    context: EspFlashReadContext,
    plan: EspFlashPlan,
  ): Promise<ReadonlyMap<EspFlashRegion, EspFlashWrittenExtent>> {
    // A partition the dump holds none of has nothing to observe.
    const held = plan.regions.filter(
      ({ partition, available }) => partition !== undefined && available > 0,
    );
    this.assertOpen(context.signal);
    const extents = await writtenExtents(
      context,
      held.map(({ fileOffset, available }) => ({
        start: fileOffset,
        length: available,
      })),
      () => this.assertOpen(context.signal),
    );
    return new Map(held.map((region, index) => [region, extents[index]!]));
  }

  /**
   * ESP image facts for the bootloader region and each app partition.
   * Regions over the same bytes share one decode, however many the table
   * declares.
   */
  async #decodeImages(
    context: EspFlashReadContext,
    plan: EspFlashPlan,
  ): Promise<ReadonlyMap<EspFlashRegion, EspFlashImageFacts>> {
    const images = new Map<EspFlashRegion, EspFlashImageFacts>();
    const decoded = new Map<string, EspFlashImageFacts>();
    for (const region of plan.regions) {
      const image =
        region.role === "bootloader" ||
        (region.partition !== undefined && isEspAppPartition(region.partition));
      if (!image || region.available === 0) continue;
      this.assertOpen(context.signal);
      const range = `${String(region.fileOffset)}+${String(region.available)}`;
      let facts = decoded.get(range);
      if (facts === undefined) {
        facts = await decodeEspFlashImage(
          context,
          { start: region.fileOffset, length: region.available },
          () => this.assertOpen(context.signal),
        );
        decoded.set(range, facts);
      }
      // Each region owns its facts, so no metadata aliases another's.
      images.set(region, structuredClone(facts));
    }
    return images;
  }
}

/** App slots the bootloader finds empty that still hold written bytes. */
const erasedSlotLimitations = (
  images: ReadonlyMap<EspFlashRegion, EspFlashImageFacts>,
  written: ReadonlyMap<EspFlashRegion, EspFlashWrittenExtent>,
): string[] =>
  [...images].flatMap(([region, image]) => {
    const extent = written.get(region);
    const limitation =
      region.partition === undefined ||
      image.status !== "erased" ||
      extent === undefined
        ? undefined
        : espErasedSlotLimitation(region.path, extent);
    return limitation === undefined ? [] : [limitation];
  });

/** One positional entry; a partition's declared flags stay metadata. */
const regionEntry = (
  region: EspFlashRegion,
  written: EspFlashWrittenExtent | undefined,
  fileSize: number,
): PositionalArtifactEntry => ({
  path: region.path,
  ...(region.partition?.label === null || region.partition === undefined
    ? {}
    : { sourcePath: region.partition.label }),
  kind: "file",
  declaredSize: region.available,
  compressedSize: null,
  executable: false,
  // The table's encrypted flag says how a device stores the partition, not
  // that these bytes are ciphertext.
  encrypted: false,
  // A partition past the end holds no bytes: its entry is the empty range
  // at the end of the file, which opens as an empty stream without a read.
  byteOffset: Math.min(region.fileOffset, fileSize),
  declaredIntegrity: null,
  unpacked: false,
  limitations:
    region.available === 0
      ? [
          `${region.path} lies outside the dump: the file holds none of its ${String(region.length)} bytes.`,
        ]
      : region.available < region.length
        ? [
            `${region.path} is truncated: the dump holds ${String(region.available)} of its ${String(region.length)} bytes.`,
          ]
        : [],
  adapterKey: `esp-flash-image:${region.path}`,
  ...(region.partition === undefined
    ? {}
    : { formatMetadata: espFlashPartitionFacts(region.partition, written) }),
});

const layoutMetadata = (
  location: EspFlashLocation,
  plan: EspFlashPlan,
  facts: EspFlashLayoutFacts,
  images: ReadonlyMap<EspFlashRegion, EspFlashImageFacts>,
): EspFlashImageMetadata => {
  const bootloaderRegion = plan.regions.find(
    ({ role }) => role === "bootloader",
  );
  const bootloaderFacts =
    bootloaderRegion === undefined ? undefined : images.get(bootloaderRegion);
  const placed = new Set(
    plan.regions.flatMap(({ partition }) =>
      partition === undefined ? [] : [partition.index],
    ),
  );
  const { bootloader, table } = location;
  return {
    kind: "esp-flash-image",
    flash_offset: location.origin,
    chip:
      bootloader === undefined
        ? null
        : {
            target: bootloader.chip.target,
            isa: bootloader.chip.isa,
            source: ESP_CHIP_TABLE_SOURCE,
          },
    bootloader:
      bootloaderRegion === undefined || bootloaderFacts === undefined
        ? null
        : {
            path: bootloaderRegion.path,
            flash_address: bootloaderRegion.flashAddress,
            region_size: bootloaderRegion.length,
            facts: bootloaderFacts,
          },
    partition_table: {
      flash_address: location.tableAddress,
      method: location.tableMethod,
      partition_count: table.partitions.length,
      md5: {
        status: table.md5.status,
        stored: table.md5.stored,
        computed: table.md5.computed,
      },
    },
    partitions_outside_dump: table.partitions
      .filter(({ index }) => !placed.has(index))
      .map((part) => espFlashPartitionFacts(part)),
    apps: [...images].flatMap(([region, image]) =>
      region.partition === undefined
        ? []
        : [
            {
              path: region.path,
              partition_index: region.partition.index,
              facts: image,
            },
          ],
    ),
    otadata:
      facts.otadata === null
        ? null
        : {
            partition_index: facts.otadata.partition_index,
            records: facts.otadata.records.map((record) => ({ ...record })),
          },
    boot_selection: {
      ...facts.boot_selection,
      assumptions: [...facts.boot_selection.assumptions],
    },
    undescribed: [...facts.undescribed],
  };
};
