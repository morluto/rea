import type { QualcommMbnMetadata } from "../domain/formatMetadata/firmwareMetadata.js";
import { boundedList } from "../domain/boundedList.js";
import {
  QUALCOMM_MBN_INLINE_SEGMENT_HASH_LIMIT,
  qualcommMbnInventoryCoverage,
  qualcommMbnStoredRegions,
  type QualcommMbnByteRange,
  type QualcommMbnElfInspection,
  type QualcommMbnHeader,
  type QualcommMbnLegacyInspection,
  type QualcommMbnRanges,
} from "../domain/qualcommMbnImage.js";
import {
  ArtifactReaderFailure,
  malformedArtifact,
} from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import { readQualcommMbnInspection } from "./QualcommMbnLocation.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/**
 * Inventory a Qualcomm MBN image's header, code (or ELF hash table),
 * signature, certificate chain and metadata regions as stored byte ranges.
 * Signatures are located, never verified.
 */
export class QualcommMbnArtifactReader extends PositionalArtifactReader<QualcommMbnMetadata> {
  override readonly format = "qualcomm-mbn" as const;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "Qualcomm MBN", admitted);
  }

  formatMetadata(): QualcommMbnMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override entryEndedEarly(
    entry: PositionalArtifactEntry,
  ): ArtifactReaderFailure {
    return malformedArtifact(
      "qualcomm-mbn",
      `Qualcomm MBN region ended early: ${entry.path}`,
    );
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<QualcommMbnMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const assertActive = (): void => this.assertOpen(signal);
    const fileSize = initial.size;
    const inspection = await readQualcommMbnInspection(
      (offset, length) =>
        readFileHandleRange(handle, offset, length, assertActive),
      fileSize,
    );
    if (inspection.kind === "unrecognized")
      throw malformedArtifact(
        "qualcomm-mbn",
        `Qualcomm MBN header: ${inspection.detail}`,
        { offset: 0, field: "header" },
      );
    // Classification admits an ELF image only for its hash segment.
    if (inspection.kind === "elf" && inspection.hashSegment === null)
      throw malformedArtifact(
        "qualcomm-mbn",
        "Qualcomm MBN header: no program header declares a Qualcomm hash segment",
        { offset: 0, field: "header" },
      );
    const entries = qualcommMbnStoredRegions(inspection).map(regionEntry);
    return {
      entries,
      coverage: {
        status: qualcommMbnInventoryCoverage(inspection),
        limitations: [...inspection.limitations],
      },
      formatMetadata: metadataOf(inspection),
    };
  }
}

const regionEntry = ({
  name,
  range,
}: {
  readonly name: string;
  readonly range: QualcommMbnByteRange;
}): PositionalArtifactEntry => ({
  path: `${name}.bin`,
  kind: "file",
  declaredSize: range.length,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: range.offset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [],
  adapterKey: `qualcomm-mbn:${name}`,
});

const rangeOf = (
  range: QualcommMbnByteRange,
): { offset: number; length: number } => ({
  offset: range.offset,
  length: range.length,
});

const headerMetadata = (
  header: QualcommMbnHeader,
  ranges: QualcommMbnRanges,
): NonNullable<QualcommMbnMetadata["header"]> => ({
  version: header.version,
  header_bytes: header.headerBytes,
  image_id: header.imageId,
  image_source: header.imageSource,
  image_source_name: header.imageSourceName,
  image_destination: header.imageDestination,
  image_size: header.imageSize,
  code_size: header.codeSize,
  signature_pointer: header.signaturePointer,
  signature_size: header.signatureSize,
  certificate_chain_pointer: header.certificateChainPointer,
  certificate_chain_size: header.certificateChainSize,
  metadata0_size: header.metadata0Size,
  qti_signature_size: header.qtiSignatureSize,
  metadata1_size: header.metadata1Size,
  qti_certificate_chain_size: header.qtiCertificateChainSize,
  ranges: {
    header: rangeOf(ranges.header),
    code: rangeOf(ranges.code),
    signature: rangeOf(ranges.signature),
    certificate_chain: rangeOf(ranges.certificateChain),
    qti_signature:
      ranges.qtiSignature === null ? null : rangeOf(ranges.qtiSignature),
    qti_certificate_chain:
      ranges.qtiCertificateChain === null
        ? null
        : rangeOf(ranges.qtiCertificateChain),
    metadata0: ranges.metadata0 === null ? null : rangeOf(ranges.metadata0),
    metadata1: ranges.metadata1 === null ? null : rangeOf(ranges.metadata1),
  },
});

const metadataOf = (
  inspection: QualcommMbnLegacyInspection | QualcommMbnElfInspection,
): QualcommMbnMetadata => {
  if (inspection.kind === "legacy")
    return {
      kind: "qualcomm-mbn",
      layout: "legacy",
      header: headerMetadata(inspection.header, inspection.ranges),
      elf: null,
    };
  const { facet, hashSegment } = inspection;
  const hashes = boundedList(
    facet?.segmentHashes ?? [],
    QUALCOMM_MBN_INLINE_SEGMENT_HASH_LIMIT,
  );
  return {
    kind: "qualcomm-mbn",
    layout: "elf",
    header: facet === null ? null : headerMetadata(facet.header, facet.ranges),
    elf: {
      elf_class: inspection.elfClass,
      byte_order: inspection.byteOrder,
      machine: inspection.machine,
      program_header_count: inspection.programHeaderCount,
      hash_segment_program_header: hashSegment?.programHeaderIndex ?? null,
      hash_segment_offset: hashSegment?.offset ?? null,
      hash_segment_file_size: hashSegment?.fileSize ?? null,
      hash_size: facet?.hashSize ?? null,
      hash_count: facet?.hashCount ?? null,
      segment_hashes: hashes.items.map((hash) => ({
        program_header: hash.programHeaderIndex,
        segment_type: hash.segmentType,
        file_offset: hash.fileOffset,
        file_size: hash.fileSize,
        hash_offset: hash.hashOffset,
      })),
      omitted_segment_hashes: hashes.omitted,
    },
  };
};
