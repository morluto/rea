import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import {
  DEFAULT_ISO9660_READER_LIMITS,
  type Iso9660ReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { Budget } from "../domain/budget.js";
import type {
  Iso9660EntryMetadata,
  Iso9660Metadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import type {
  ParseFailure,
  ParseFailureError,
  ParseFailureKind,
} from "../domain/parseFailure.js";
import type { Result } from "../domain/result.js";
import {
  admitIso9660Extent,
  extentOf,
  parsedIso9660,
  ISO9660_DESCRIPTOR_OFFSET,
  ISO9660_LIMITS,
  ISO9660_SECTOR_BYTES,
  iso9660DirectoryIsInterleaved,
  iso9660LimitFailure,
  parseIso9660DirectoryExtent,
  type Iso9660DirectoryLink,
  type Iso9660DirectoryRecord,
  type Iso9660Extent,
  type Iso9660ExtentLayout,
} from "../domain/iso9660/iso9660Structures.js";
import {
  groupIso9660Members,
  iso9660MemberIsAssociated,
  iso9660MemberIsHidden,
  iso9660PathSegment,
  type Iso9660Member,
} from "../domain/iso9660/iso9660Members.js";
import {
  parseIso9660VolumeDescriptors,
  type Iso9660VolumeDescriptorSet,
} from "../domain/iso9660/iso9660VolumeDescriptors.js";
import { malformedInput, unsupportedInput } from "../domain/parseFailure.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  ArtifactEntryContentUnavailable,
  artifactReaderLimitFailure,
  artifactParseFailure,
  type ArtifactReaderFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

type IsoEntry = PositionalArtifactEntry & {
  readonly formatMetadata: Iso9660EntryMetadata;
};

interface PendingDirectory {
  readonly record: Pick<
    Iso9660DirectoryRecord,
    | "offset"
    | "extentLocation"
    | "extendedAttributeLength"
    | "dataLength"
    | "fileUnitSize"
    | "interleaveGapSize"
  >;
  /** The record that admitted the parent, which `..` must describe. */
  readonly parent: Iso9660DirectoryLink;
  readonly path: string;
  readonly sourcePath: string;
  readonly depth: number;
}

const layoutLimitation = (
  layout: Exclude<Iso9660ExtentLayout, "contiguous">,
): string =>
  layout === "interleaved"
    ? "ISO 9660 interleaved file units are listed but not read; the file's bytes were not established."
    : "ISO 9660 file has separated extents and cannot be extracted. The file is listed, and source_location covers only its first extent.";

/**
 * Read an ISO 9660 image offline: the volume descriptor set and the
 * directory tree, Joliet names when present. Files are served as carrier
 * ranges; nothing is mounted or executed.
 */
export class Iso9660ArtifactReader extends PositionalArtifactReader<Iso9660Metadata> {
  override readonly format = "iso9660" as const;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly expandedBytes?: number,
    private readonly limits: Iso9660ReaderLimits = DEFAULT_ISO9660_READER_LIMITS,
  ) {
    super(path, "ISO 9660 image", admitted);
  }

  formatMetadata(): Iso9660Metadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : { ...metadata };
  }

  /** Separated or interleaved extents are not one carrier range. */
  protected override contentRefusal(
    entry: PositionalArtifactEntry,
  ): ArtifactReaderFailure | undefined {
    const metadata = entry.formatMetadata;
    if (
      metadata?.kind !== "iso9660-entry" ||
      metadata.extent_layout === "contiguous"
    )
      return super.contentRefusal(entry);
    return new ArtifactEntryContentUnavailable(
      `ISO 9660 file ${entry.path} has ${metadata.extent_layout} extents that this reader does not read`,
      layoutLimitation(metadata.extent_layout),
    );
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<Iso9660Metadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const fileSize = initial.size;
    const available = Math.max(0, fileSize - ISO9660_DESCRIPTOR_OFFSET);
    const descriptorBytes = await readArtifactFileBytes(
      "iso9660",
      handle,
      ISO9660_DESCRIPTOR_OFFSET,
      Math.min(
        this.limits.descriptor_count * ISO9660_SECTOR_BYTES,
        available - (available % ISO9660_SECTOR_BYTES),
      ),
      fileSize,
      signal,
    );
    this.assertOpen(signal);
    const volume = unwrap(
      parseIso9660VolumeDescriptors(
        descriptorBytes,
        fileSize,
        this.limits.descriptor_count,
      ),
    );
    const tree = await this.#traverse(handle, fileSize, volume, signal);
    return {
      entries: tree.entries,
      formatMetadata: toMetadata(volume, tree),
      coverage: {
        status: volume.treeCoverage,
        limitations: [...volume.limitations],
      },
    };
  }

  async #traverse(
    handle: Pick<FileHandle, "read">,
    fileSize: number,
    volume: Iso9660VolumeDescriptorSet,
    signal?: AbortSignal,
  ): Promise<IsoTree> {
    const joliet = volume.nameSource === "joliet";
    const root = volume.treeRoot;
    const tree = new IsoTree(
      root.extentLocation,
      fileSize,
      volume.volumeSpaceSize * ISO9660_SECTOR_BYTES,
      this.expandedBytes,
      this.limits,
    );
    let records = 0;
    const charge = () => {
      if (++records > this.limits.record_count)
        throw iso9660LimitFailure(
          ISO9660_LIMITS.records,
          records,
          this.limits.record_count,
        );
    };
    // Each step examines one record or one sector of padding, listed or not.
    let steps = 0;
    const stack: PendingDirectory[] = [
      {
        record: root,
        parent: root,
        path: "",
        sourcePath: "",
        depth: 0,
      },
    ];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      const extent = tree.directoryExtent(directory);
      this.assertOpen(signal);
      const bytes = await readArtifactFileBytes(
        "iso9660",
        handle,
        extent.dataOffset,
        extent.dataLength,
        fileSize,
        signal,
      );
      this.assertOpen(signal);
      const members = groupIso9660Members(
        parseIso9660DirectoryExtent(
          bytes,
          extent.dataOffset,
          charge,
          {
            size: volume.volumeSetSize,
            sequence: volume.volumeSequenceNumber,
          },
          { self: directory.record, parent: directory.parent },
        ),
        joliet,
        (section) => tree.admitExtent(section),
      );
      const used = new Set<string>();
      const children: PendingDirectory[] = [];
      while (true) {
        const next = unwrap(parsedIso9660(() => members.next()));
        if (next.done) break;
        if (++steps % 256 === 0) await setImmediate();
        this.assertOpen(signal);
        const member = next.value;
        if (member === undefined) continue;
        const child = tree.add(member, directory, used);
        if (child !== undefined) children.push(child);
      }
      // Depth-first, with each directory's children in record order.
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
    return tree;
  }
}

/** Entries and the bounds one traversal has spent. */
class IsoTree {
  readonly entries: IsoEntry[] = [];
  directoryCount = 0;
  fileCount = 0;
  readonly #visited: Set<number>;
  readonly #fileSize: number;
  readonly #volumeBytes: number;
  readonly #limits: Iso9660ReaderLimits;
  readonly #directoryBytes: Budget;
  readonly #pathBytes: Budget;
  /**
   * Extents may be shared; every readable file is hashed separately.
   * Separated and interleaved files are refused before any byte is read, so
   * they are not charged.
   */
  readonly #declaredBytes: Budget;

  constructor(
    rootExtent: number,
    fileSize: number,
    volumeBytes: number,
    expandedBytes?: number,
    limits: Iso9660ReaderLimits = DEFAULT_ISO9660_READER_LIMITS,
  ) {
    this.#visited = new Set([rootExtent]);
    this.#fileSize = fileSize;
    this.#volumeBytes = volumeBytes;
    this.#limits = limits;
    this.#directoryBytes = new Budget(limits.directory_bytes);
    this.#pathBytes = new Budget(limits.path_bytes);
    this.#declaredBytes = new Budget(
      expandedBytes ??
        artifactExpansionBudgetBytes(Math.min(fileSize, volumeBytes)),
    );
  }

  /** Admit a directory's extent before its bytes are read. */
  directoryExtent(directory: PendingDirectory): Iso9660Extent {
    const { record } = directory;
    if (iso9660DirectoryIsInterleaved(record))
      throw parseFailure(
        unsupportedInput(
          "iso9660",
          `ISO 9660 directory ${directory.path || "/"} is interleaved, which this reader does not decode`,
          {
            offset: record.offset + 26,
            field: "file_unit_size",
            undecodedContent: true,
          },
        ),
      );
    // The bytes must be able to exist before they are charged as work.
    const extent = extentOf(record);
    this.admitExtent(extent);
    this.#directoryBytes.charge(record.dataLength, () =>
      parseFailure(
        iso9660LimitFailure(
          ISO9660_LIMITS.directoryBytes,
          this.#directoryBytes.used + record.dataLength,
          this.#limits.directory_bytes,
        ),
      ),
    );
    return extent;
  }

  admitExtent(extent: Iso9660Extent): void {
    unwrap(admitIso9660Extent(extent, this.#fileSize, this.#volumeBytes));
  }

  /** List one member; a subdirectory is returned for traversal. */
  add(
    member: Iso9660Member,
    directory: PendingDirectory,
    used: Set<string>,
  ): PendingDirectory | undefined {
    const index = this.entries.length;
    const { segment, renamed } = iso9660PathSegment(
      member.name,
      index,
      used,
      member.directory && directory.path === "",
    );
    const path =
      directory.path === "" ? segment : `${directory.path}/${segment}`;
    const sourcePath =
      directory.sourcePath === ""
        ? member.identifier
        : `${directory.sourcePath}/${member.identifier}`;
    // Charge the expanded spellings before the entry retains them.
    const pathBytes =
      Buffer.byteLength(path, "utf8") + Buffer.byteLength(sourcePath, "utf8");
    this.#pathBytes.charge(pathBytes, () =>
      parseFailure(
        iso9660LimitFailure(
          ISO9660_LIMITS.pathBytes,
          this.#pathBytes.used + pathBytes,
          this.#limits.path_bytes,
        ),
      ),
    );
    this.entries.push(entryFor(member, { index, path, sourcePath, renamed }));
    if (!member.directory) {
      this.fileCount += 1;
      if (member.layout !== "contiguous") return undefined;
      const budget = this.#declaredBytes;
      budget.charge(member.dataLength, () =>
        artifactReaderLimitFailure(
          "artifact_limits.expanded_bytes",
          budget.maximum,
          "bytes",
          budget.used + member.dataLength,
        ),
      );
      return undefined;
    }
    this.directoryCount += 1;
    const first = member.extents[0]!;
    if (this.#visited.has(first.location))
      throw parseFailure(
        malformedInput(
          "iso9660",
          `ISO 9660 image is malformed: directory ${path} revisits the extent at block ${String(first.location)}`,
          { offset: member.recordOffset + 2, field: "extent_location" },
        ),
      );
    this.#visited.add(first.location);
    if (directory.depth + 1 > this.#limits.directory_depth)
      throw parseFailure(
        iso9660LimitFailure(
          ISO9660_LIMITS.depth,
          directory.depth + 1,
          this.#limits.directory_depth,
        ),
      );
    return {
      record: {
        offset: member.recordOffset,
        extentLocation: first.location,
        extendedAttributeLength: first.extendedAttributeLength,
        dataLength: first.dataLength,
        fileUnitSize: member.fileUnitSize,
        interleaveGapSize: member.interleaveGapSize,
      },
      parent: directory.record,
      path,
      sourcePath,
      depth: directory.depth + 1,
    };
  }
}

const unwrap = <T>(result: Result<T, ParseFailureError>): T => {
  if (!result.ok) throw parseFailure(result.error);
  return result.value;
};

const ISO9660_LIMIT_BY_NAME = new Map(
  Object.values(ISO9660_LIMITS).map((limit) => [limit.name, limit] as const),
);

const parseFailure = <Kind extends ParseFailureKind>(
  failure: ParseFailureError<Kind>,
): Error => {
  const facts: ParseFailure = failure.failure;
  if (facts.kind === "limit") {
    const spec = ISO9660_LIMIT_BY_NAME.get(facts.limit.name);
    if (spec !== undefined)
      return artifactReaderLimitFailure(
        spec.parameter,
        facts.limit.maximum,
        spec.unit,
        facts.limit.required,
      );
  }
  const mapped = artifactParseFailure(failure, undefined, () => "capacity");
  return mapped instanceof Error ? mapped : failure;
};

const entryFor = (
  member: Iso9660Member,
  {
    index,
    path,
    sourcePath,
    renamed,
  }: {
    readonly index: number;
    readonly path: string;
    readonly sourcePath: string;
    readonly renamed: boolean;
  },
): IsoEntry => {
  const first = member.extents[0]!;
  const layout = member.directory ? "contiguous" : member.layout;
  return {
    path,
    sourcePath,
    kind: member.directory ? "directory" : "file",
    declaredSize: member.dataLength,
    compressedSize: null,
    executable: false,
    encrypted: false,
    byteOffset: first.dataOffset,
    ...(layout === "contiguous" ? {} : { byteLength: first.leadingRunBytes }),
    declaredIntegrity: null,
    unpacked: false,
    limitations: [
      ...(layout === "contiguous" ? [] : [layoutLimitation(layout)]),
      ...(!member.directory &&
      member.dataLength === 0 &&
      first.extendedAttributeLength === 0 &&
      first.dataOffset >= ISO9660_SECTOR_BYTES * 0xfffffff0
        ? [
            "ISO 9660 empty file records the unallocated extent sentinel; source_location repeats the declared block and names no stored bytes.",
          ]
        : []),
      ...(member.identifierCharset === "undeclared"
        ? [
            "ISO 9660 primary identifier has bytes above 0x7F, which ECMA-119 does not assign; they are shown as Latin-1 and the intended characters are unknown.",
          ]
        : []),
      ...(renamed
        ? [
            `ISO 9660 identifier is not a safe path segment and is listed as ${path.slice(path.lastIndexOf("/") + 1)}; source_path keeps the stored identifier.`,
          ]
        : []),
    ],
    adapterKey: `iso9660:${String(index)}`,
    formatMetadata: {
      kind: "iso9660-entry",
      index,
      identifier: member.identifier,
      extent_location: first.location,
      extended_attribute_length: first.extendedAttributeLength,
      extent_count: member.extents.length,
      extent_layout: layout,
      file_flags: member.flags,
      hidden: iso9660MemberIsHidden(member),
      associated: iso9660MemberIsAssociated(member),
      recording_date: member.recordingDate,
      file_unit_size: member.fileUnitSize,
      interleave_gap_size: member.interleaveGapSize,
    },
  };
};

const toMetadata = (
  volume: Iso9660VolumeDescriptorSet,
  tree: { readonly directoryCount: number; readonly fileCount: number },
): Iso9660Metadata => ({
  kind: "iso9660",
  system_identifier: volume.systemIdentifier,
  volume_identifier: volume.volumeIdentifier,
  volume_set_identifier: volume.volumeSetIdentifier,
  publisher_identifier: volume.publisherIdentifier,
  data_preparer_identifier: volume.dataPreparerIdentifier,
  application_identifier: volume.applicationIdentifier,
  volume_space_size: volume.volumeSpaceSize,
  logical_block_size: volume.logicalBlockSize,
  volume_set_size: volume.volumeSetSize,
  volume_sequence_number: volume.volumeSequenceNumber,
  path_table_size: volume.pathTableSize,
  root_directory_extent: volume.treeRoot.extentLocation,
  creation_date: volume.creationDate,
  modification_date: volume.modificationDate,
  expiration_date: volume.expirationDate,
  effective_date: volume.effectiveDate,
  volume_descriptor_count: volume.descriptorCount,
  el_torito_boot_record: volume.elTorito,
  boot_catalog_sector: volume.bootCatalogSector,
  joliet_level: volume.jolietLevel,
  name_source: volume.nameSource,
  directory_count: tree.directoryCount,
  file_count: tree.fileCount,
});
