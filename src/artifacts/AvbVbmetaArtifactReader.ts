import type { FileHandle } from "node:fs/promises";
import type { ParseFailureError } from "../domain/parseFailure.js";

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
  AvbVbmetaDescriptorEntryMetadata,
  AvbVbmetaDescriptorMetadata,
  AvbVbmetaImageMetadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import {
  AVB_VBMETA_FIXED_LIMITS,
  AVB_VBMETA_MAX_IMAGE_BYTES,
  parseAvbVbmetaImage,
  type AvbDescriptor,
  type AvbVbmetaParse,
} from "./AndroidBootImageFormat.js";

type VbmetaEntry = PositionalArtifactEntry & {
  readonly formatMetadata: AvbVbmetaDescriptorEntryMetadata;
};

/** Read a standalone `AVB0` vbmeta image without verifying or altering it. */
export class AvbVbmetaArtifactReader extends PositionalArtifactReader<AvbVbmetaImageMetadata> {
  override readonly format = "avb-vbmeta-image" as const;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "AVB vbmeta image", admitted);
  }

  formatMetadata(): AvbVbmetaImageMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : { ...metadata };
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<AvbVbmetaImageMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    if (initial.size > AVB_VBMETA_MAX_IMAGE_BYTES) {
      const ceiling = AVB_VBMETA_FIXED_LIMITS.get("AVB vbmeta image size");
      if (ceiling !== undefined)
        throw artifactFixedLimitFailure(
          {
            name: ceiling.name,
            kind: "parser",
            limit: ceiling.maximum,
            unit: ceiling.unit,
          },
          `vbmeta image is ${initial.size} bytes, larger than the ${AVB_VBMETA_MAX_IMAGE_BYTES} byte bound`,
          "capacity",
        );
    }
    const bytes = await readArtifactFileBytes(
      "avb-vbmeta-image",
      handle,
      0,
      initial.size,
      initial.size,
      signal,
    );
    this.assertOpen(signal);
    const parsed = parseAvbVbmetaImage(bytes, initial.size);
    if (!parsed.ok) throw parseFailure(parsed.error);
    const vbmeta = parsed.value;
    const entries: VbmetaEntry[] = vbmeta.descriptors.map((descriptor) =>
      entryFor(descriptor),
    );
    return {
      entries,
      formatMetadata: toMetadata(vbmeta),
      coverage: {
        status: "complete",
        limitations: [...vbmeta.limitations],
      },
    };
  }
}

const entryFor = (descriptor: AvbDescriptor): VbmetaEntry => {
  const path = `descriptor-${String(descriptor.index)}-${descriptor.tagName}.bin`;
  return {
    path,
    kind: "file",
    declaredSize: descriptor.size,
    compressedSize: null,
    executable: false,
    encrypted: false,
    byteOffset: descriptor.offset,
    declaredIntegrity: null,
    unpacked: false,
    limitations: [],
    adapterKey: `avb-vbmeta-image:descriptor-${String(descriptor.index)}`,
    formatMetadata: {
      kind: "avb-vbmeta-descriptor",
      index: descriptor.index,
      tag: descriptor.tag.toString(),
      tag_name: descriptor.tagName,
      descriptor_size: descriptor.size,
    },
    sourcePath: path,
  };
};

const toDescriptorMetadata = (
  descriptor: AvbDescriptor,
): AvbVbmetaDescriptorMetadata => {
  switch (descriptor.kind) {
    case "property":
      return {
        kind: "property",
        index: descriptor.index,
        tag: descriptor.tag.toString(),
        offset: descriptor.offset,
        size: descriptor.size,
        key: descriptor.key,
        key_bytes_hex: descriptor.keyBytesHex,
        value: descriptor.value,
        value_bytes_hex: descriptor.valueBytesHex,
      };
    case "hashtree":
      return {
        kind: "hashtree",
        index: descriptor.index,
        tag: descriptor.tag.toString(),
        offset: descriptor.offset,
        size: descriptor.size,
        dm_verity_version: descriptor.dmVerityVersion,
        image_size: descriptor.imageSize,
        tree_offset: descriptor.treeOffset,
        tree_size: descriptor.treeSize,
        data_block_size: descriptor.dataBlockSize,
        hash_block_size: descriptor.hashBlockSize,
        fec_num_roots: descriptor.fecNumRoots,
        fec_offset: descriptor.fecOffset,
        fec_size: descriptor.fecSize,
        hash_algorithm: descriptor.hashAlgorithm,
        hash_algorithm_bytes_hex: descriptor.hashAlgorithmBytesHex,
        partition_name: descriptor.partitionName,
        partition_name_bytes_hex: descriptor.partitionNameBytesHex,
        salt_hex: descriptor.saltHex,
        root_digest_hex: descriptor.rootDigestHex,
        flags: descriptor.flags,
      };
    case "hash":
      return {
        kind: "hash",
        index: descriptor.index,
        tag: descriptor.tag.toString(),
        offset: descriptor.offset,
        size: descriptor.size,
        image_size: descriptor.imageSize,
        hash_algorithm: descriptor.hashAlgorithm,
        hash_algorithm_bytes_hex: descriptor.hashAlgorithmBytesHex,
        partition_name: descriptor.partitionName,
        partition_name_bytes_hex: descriptor.partitionNameBytesHex,
        salt_hex: descriptor.saltHex,
        digest_hex: descriptor.digestHex,
        flags: descriptor.flags,
      };
    case "kernel-cmdline":
      return {
        kind: "kernel-cmdline",
        index: descriptor.index,
        tag: descriptor.tag.toString(),
        offset: descriptor.offset,
        size: descriptor.size,
        flags: descriptor.flags,
        cmdline: descriptor.cmdline,
        cmdline_bytes_hex: descriptor.cmdlineBytesHex,
      };
    case "chain-partition":
      return {
        kind: "chain-partition",
        index: descriptor.index,
        tag: descriptor.tag.toString(),
        offset: descriptor.offset,
        size: descriptor.size,
        rollback_index_location: descriptor.rollbackIndexLocation,
        partition_name: descriptor.partitionName,
        partition_name_bytes_hex: descriptor.partitionNameBytesHex,
        public_key_size: descriptor.publicKeySize,
        flags: descriptor.flags,
      };
    case "unknown":
      return {
        kind: "unknown",
        index: descriptor.index,
        tag: descriptor.tag.toString(),
        offset: descriptor.offset,
        size: descriptor.size,
      };
  }
};

const toMetadata = (vbmeta: AvbVbmetaParse): AvbVbmetaImageMetadata => ({
  kind: "avb-vbmeta-image",
  required_libavb_version_major: vbmeta.requiredLibavbVersionMajor,
  required_libavb_version_minor: vbmeta.requiredLibavbVersionMinor,
  authentication_data_block_size: vbmeta.authenticationDataBlockSize,
  auxiliary_data_block_size: vbmeta.auxiliaryDataBlockSize,
  algorithm_type: vbmeta.algorithmType,
  algorithm_type_name: vbmeta.algorithmTypeName,
  hash_offset: vbmeta.hashOffset,
  hash_size: vbmeta.hashSize,
  signature_offset: vbmeta.signatureOffset,
  signature_size: vbmeta.signatureSize,
  public_key_offset: vbmeta.publicKeyOffset,
  public_key_size: vbmeta.publicKeySize,
  public_key_metadata_offset: vbmeta.publicKeyMetadataOffset,
  public_key_metadata_size: vbmeta.publicKeyMetadataSize,
  descriptors_offset: vbmeta.descriptorsOffset,
  descriptors_size: vbmeta.descriptorsSize,
  rollback_index: vbmeta.rollbackIndex.toString(),
  flags: vbmeta.flags,
  flag_names: [...vbmeta.flagNames],
  rollback_index_location: vbmeta.rollbackIndexLocation,
  release_string: vbmeta.releaseString,
  release_string_bytes_hex: vbmeta.releaseStringBytesHex,
  descriptors: vbmeta.descriptors.map(toDescriptorMetadata),
  descriptor_count: vbmeta.descriptors.length,
  image_size: vbmeta.imageSize,
  trailing_bytes: vbmeta.trailingBytes,
});

const parseFailure = (failure: ParseFailureError): unknown => {
  const facts = failure.failure;
  if (facts.kind === "limit") {
    const ceiling = AVB_VBMETA_FIXED_LIMITS.get(facts.limit.name);
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
