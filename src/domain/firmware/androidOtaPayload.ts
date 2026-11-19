import { zstdDecompressSync } from "node:zlib";

import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

import { sha256Hex } from "../../kernel/sha256Hex.js";
import {
  decodeLimit,
  hostRangeErrorKind,
  malformedInput,
  ParseFailureError,
  truncatedInput,
  unsupportedInput,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";

/**
 * Field numbers are from AOSP `system/update_engine/update_metadata.proto`
 * (`chromeos_update_engine.DeltaArchiveManifest` and nested messages). Only
 * the fields this reader reports are decoded; unknown fields are skipped.
 *
 * DeltaArchiveManifest: block_size=3, signatures_offset=4, signatures_size=5,
 * minor_version=12, partitions=13, max_timestamp=14,
 * dynamic_partition_metadata=15, partial_update=16, apex_info=17,
 * security_patch_level=18.
 * PartitionUpdate: partition_name=1, run_postinstall=2, postinstall_path=3,
 * filesystem_type=4, old_partition_info=6, new_partition_info=7,
 * operations=8, version=17, merge_operations=18, estimate_cow_size=19.
 * InstallOperation: type=1, data_offset=2, data_length=3, src_extents=4,
 * dst_extents=6.
 * Extent: start_block=1, num_blocks=2.
 * PartitionInfo: size=1, hash=2.
 * DynamicPartitionMetadata: groups=1, snapshot_enabled=2, vabc_enabled=3,
 * vabc_compression_param=4.
 * DynamicPartitionGroup: name=1, size=2, partition_names=3.
 * ApexInfo: package_name=1, version=2, is_compressed=3, decompressed_size=4.
 * Signatures: signatures=1.
 */
export const ANDROID_OTA_MAGIC = "CrAU";
export const ANDROID_OTA_MAGIC_BYTES = Buffer.from(ANDROID_OTA_MAGIC, "latin1");
export const ANDROID_OTA_MAJOR_VERSION = 2n;
export const ANDROID_OTA_HEADER_V2_BYTES = 24;
export const ANDROID_OTA_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const ANDROID_OTA_MAX_PARTITIONS = 4096;
export const ANDROID_OTA_MAX_OPERATIONS = 65_536;
export const ANDROID_OTA_MAX_OPERATIONS_TOTAL = 262_144;
export const ANDROID_OTA_MAX_EXTENTS_TOTAL = 1_048_576;
export const ANDROID_OTA_MAX_SIGNATURE_BYTES = 1024 * 1024;
export const ANDROID_OTA_MAX_SIGNATURES = 64;
export const ANDROID_OTA_MAX_GROUPS = 256;
export const ANDROID_OTA_MAX_GROUP_PARTITION_NAMES = 4096;
export const ANDROID_OTA_MAX_APEX = 4096;
export const ANDROID_OTA_MAX_EXTRACT_BYTES = 32 * 1024 * 1024;
export const ANDROID_OTA_MAX_OPERATION_DATA_BYTES = 32 * 1024 * 1024;
export const ANDROID_OTA_DEFAULT_BLOCK_SIZE = 4096;

export const ANDROID_OTA_PAYLOAD_LIMITATIONS = {
  inventoryScope:
    "Android OTA payload inventory reads the CrAU header and DeltaArchiveManifest. Signatures are not verified, delta operations are not applied, and partition images are reconstructed only from REPLACE, ZERO, and REPLACE_ZSTD operations.",
  signaturesUnverified:
    "Metadata and payload signatures were parsed for size and signature count only; they were not verified.",
  blobTruncated:
    "The payload blob is truncated; partition inventory comes from the manifest and operation data past the end of the file was not read.",
  unsupportedOperations:
    "Delta and compressed operations other than REPLACE_ZSTD are not applied; those partitions cannot be reconstructed.",
  missingPartitionSize:
    "A partition without a new_partition_info size cannot be reconstructed.",
  partitionSizeLimit: `A partition larger than the fixed ${String(32 * 1024 * 1024)}-byte extraction ceiling is inventoried but not reconstructed.`,
  partitionBlobTruncated:
    "A partition whose operation data extends past the end of the payload file cannot be reconstructed.",
} as const;

/** Why a partition image cannot be reconstructed, or null when it can. */
export type AndroidOtaExtractRefusal =
  | "unsupported_operations"
  | "missing_size"
  | "size_limit"
  | "blob_truncated";

/** The limitation text that names one extraction refusal. */
export const androidOtaExtractRefusalLimitation = (
  refusal: AndroidOtaExtractRefusal,
): string =>
  ({
    unsupported_operations:
      ANDROID_OTA_PAYLOAD_LIMITATIONS.unsupportedOperations,
    missing_size: ANDROID_OTA_PAYLOAD_LIMITATIONS.missingPartitionSize,
    size_limit: ANDROID_OTA_PAYLOAD_LIMITATIONS.partitionSizeLimit,
    blob_truncated: ANDROID_OTA_PAYLOAD_LIMITATIONS.partitionBlobTruncated,
  })[refusal];

/** InstallOperation.Type names keyed by the proto enumerator. */
export const INSTALL_OPERATION_NAMES: Readonly<Record<number, string>> = {
  0: "REPLACE",
  1: "REPLACE_BZ",
  2: "MOVE",
  3: "BSDIFF",
  4: "SOURCE_COPY",
  5: "SOURCE_BSDIFF",
  6: "ZERO",
  7: "DISCARD",
  8: "REPLACE_XZ",
  9: "PUFFDIFF",
  10: "BROTLI_BSDIFF",
  11: "ZUCCHINI",
  12: "LZ4DIFF_BSDIFF",
  13: "LZ4DIFF_PUFFDIFF",
  14: "REPLACE_ZSTD",
};

const EXTRACTABLE_TYPES = new Set([0, 6, 14]);

/**
 * How parsing a payload failed: the shared byte-format failure, so a short
 * header is `truncated`, an unsupported major version `unsupported`, and a
 * fixed ceiling `limit`.
 */
export type AndroidOtaPayloadParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"truncated">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

export type AndroidOtaPayloadReconstructError =
  | AndroidOtaPayloadParseError
  | {
      readonly _tag: "AndroidOtaPayloadUnsupportedOperation";
      readonly message: string;
      readonly typeCode: number;
    }
  | {
      readonly _tag: "AndroidOtaPayloadIntegrityFailure";
      readonly message: string;
      readonly declaredHashHex: string;
      readonly observedHashHex: string;
    }
  | {
      readonly _tag: "AndroidOtaPayloadBlobTruncated";
      readonly message: string;
    };

const ANDROID_OTA_FORMAT = "android-ota-payload";

const malformed = (message: string): AndroidOtaPayloadParseError =>
  malformedInput(ANDROID_OTA_FORMAT, message);

const truncated = (message: string): AndroidOtaPayloadParseError =>
  truncatedInput(ANDROID_OTA_FORMAT, message);

const unsupportedVersion = (
  majorVersion: bigint,
): AndroidOtaPayloadParseError =>
  unsupportedInput(
    ANDROID_OTA_FORMAT,
    androidOtaUnsupportedVersion(majorVersion),
    { offset: 4, field: "major_version" },
  );

const capacity = (
  name: string,
  maximum: number,
  unit: string,
): AndroidOtaPayloadParseError =>
  decodeLimit(
    ANDROID_OTA_FORMAT,
    `Android OTA payload ${name} exceeds the fixed ${String(maximum)}-${unit} ceiling`,
    { name: `Android OTA payload ${name}`, maximum },
  );

const androidOtaUnsupportedVersion = (version: bigint): string =>
  `Android OTA payload major version ${String(version)} is unsupported; this reader supports version 2 only`;

const u32be = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)) >>>
  0;

const u64be = (bytes: Uint8Array, at: number): bigint =>
  (BigInt(u32be(bytes, at)) << 32n) | BigInt(u32be(bytes, at + 4));

export const hasAndroidOtaPayloadMagic = (prefix: Buffer): boolean =>
  prefix.length >= 4 && prefix.subarray(0, 4).equals(ANDROID_OTA_MAGIC_BYTES);

export type AndroidOtaPayloadRecognition =
  | { readonly state: "recognized" }
  | { readonly state: "refused"; readonly reason: string };

/** Recognize CrAU; version 2 is supported, any other readable version is refused. */
export const recognizeAndroidOtaPayload = (
  prefix: Buffer,
): AndroidOtaPayloadRecognition | undefined => {
  if (!hasAndroidOtaPayloadMagic(prefix)) return undefined;
  if (prefix.length < 12) return { state: "recognized" };
  const version = u64be(prefix, 4);
  return version === ANDROID_OTA_MAJOR_VERSION
    ? { state: "recognized" }
    : { state: "refused", reason: androidOtaUnsupportedVersion(version) };
};

export interface AndroidOtaPayloadHeader {
  readonly magic: typeof ANDROID_OTA_MAGIC;
  readonly majorVersion: 2;
  readonly manifestSize: number;
  readonly metadataSignatureSize: number;
  readonly manifestOffset: number;
  /** End of the manifest plus a complete metadata signature, when present. */
  readonly metadataPrefixEnd: number;
  readonly blobOffset: number;
}

export interface AndroidOtaExtent {
  readonly startBlock: number | null;
  readonly numBlocks: number;
}

export interface AndroidOtaInstallOperation {
  readonly typeCode: number;
  readonly typeName: string;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly dataHashHex: string | null;
  readonly srcExtents: readonly AndroidOtaExtent[];
  readonly dstExtents: readonly AndroidOtaExtent[];
}

export interface AndroidOtaPartitionInfo {
  readonly size: number | null;
  readonly hashHex: string | null;
}

export interface AndroidOtaPartition {
  readonly index: number;
  readonly name: string;
  readonly path: string;
  readonly newPartitionInfo: AndroidOtaPartitionInfo;
  readonly oldPartitionInfo: AndroidOtaPartitionInfo | null;
  readonly version: string | null;
  readonly runPostinstall: boolean | null;
  readonly postinstallPath: string | null;
  readonly filesystemType: string | null;
  readonly operations: readonly AndroidOtaInstallOperation[];
  readonly operationCounts: readonly {
    readonly type: string;
    readonly type_code: number;
    readonly count: number;
  }[];
  readonly totalDataLength: number;
  readonly mergeOperationCount: number;
  readonly estimateCowSize: number | null;
  readonly extractable: boolean;
  /** The reason `extractable` is false, or null when the image can be rebuilt. */
  readonly extractRefusal: AndroidOtaExtractRefusal | null;
}

export interface AndroidOtaDynamicGroup {
  readonly name: string;
  readonly size: number | null;
  readonly partitionNames: readonly string[];
}

export interface AndroidOtaApexInfo {
  readonly packageName: string | null;
  readonly version: number | null;
  readonly isCompressed: boolean | null;
  readonly decompressedSize: number | null;
}

export interface AndroidOtaPayload {
  readonly header: AndroidOtaPayloadHeader;
  readonly fileSize: number;
  readonly blockSize: number;
  readonly minorVersion: number;
  readonly payloadKind: "full" | "delta";
  readonly maxTimestamp: number | null;
  readonly partialUpdate: boolean | null;
  readonly securityPatchLevel: string | null;
  readonly signaturesOffset: number | null;
  readonly signaturesSize: number | null;
  readonly metadataSignatureBlobSize: number;
  readonly metadataSignatureCount: number | null;
  readonly payloadSignatureBlobSize: number | null;
  readonly payloadSignatureRange: {
    readonly offset: number;
    readonly bytes: number;
  } | null;
  readonly payloadSignatureCount: number | null;
  readonly partitions: readonly AndroidOtaPartition[];
  readonly dynamicPartitionGroups: readonly AndroidOtaDynamicGroup[];
  readonly snapshotEnabled: boolean | null;
  readonly vabcEnabled: boolean | null;
  readonly vabcCompressionParam: string | null;
  readonly apexInfo: readonly AndroidOtaApexInfo[];
  readonly blobTruncated: boolean;
  readonly limitations: readonly string[];
}

const toBigInt = (value: bigint | string | number): bigint =>
  typeof value === "bigint"
    ? value
    : typeof value === "number"
      ? BigInt(value)
      : BigInt(value);

const asSafeUint = (
  value: bigint | string | number,
  label: string,
): Result<number, AndroidOtaPayloadParseError> => {
  const numeric = toBigInt(value);
  if (numeric < 0n || numeric > BigInt(Number.MAX_SAFE_INTEGER))
    return err(malformed(`${label} is not an exact nonnegative extent`));
  return ok(Number(numeric));
};

const asSafeInt = (value: bigint | string | number): number | null => {
  const numeric = toBigInt(value);
  if (
    numeric < BigInt(Number.MIN_SAFE_INTEGER) ||
    numeric > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null;
  return Number(numeric);
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const protobufFailure = (cause: unknown): AndroidOtaPayloadParseError =>
  malformed(
    cause instanceof Error
      ? `DeltaArchiveManifest protobuf is truncated or malformed: ${cause.message}`
      : "DeltaArchiveManifest protobuf is truncated or malformed",
  );

const fail = (failure: AndroidOtaPayloadParseError): never => {
  throw failure;
};

const unwrap = <T>(result: Result<T, AndroidOtaPayloadParseError>): T => {
  if (result.ok) return result.value;
  return fail(result.error);
};

const walk = (
  bytes: Uint8Array,
  visit: (field: number, wire: WireType, reader: BinaryReader) => void,
): Result<undefined, AndroidOtaPayloadParseError> => {
  try {
    const reader = new BinaryReader(bytes);
    while (reader.pos < reader.len) {
      const [field, wire] = reader.tag();
      visit(field, wire, reader);
    }
    return ok(undefined);
  } catch (cause: unknown) {
    return err(
      cause instanceof ParseFailureError ? cause : protobufFailure(cause),
    );
  }
};

export const parseAndroidOtaHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result<AndroidOtaPayloadHeader, AndroidOtaPayloadParseError> => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    return err(
      malformed("Android OTA payload size is not an exact nonnegative extent"),
    );
  if (
    bytes.length < 4 ||
    Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== ANDROID_OTA_MAGIC
  )
    return err(malformed("Android OTA payload magic mismatch: expected CrAU"));
  if (bytes.length < 12)
    return err(
      truncated(
        `Android OTA payload header is truncated: ${String(bytes.length)} bytes, expected ${String(ANDROID_OTA_HEADER_V2_BYTES)}`,
      ),
    );
  const majorVersion = u64be(bytes, 4);
  if (majorVersion !== ANDROID_OTA_MAJOR_VERSION)
    return err(unsupportedVersion(majorVersion));
  if (bytes.length < ANDROID_OTA_HEADER_V2_BYTES)
    return err(
      truncated(
        `Android OTA payload header is truncated: ${String(bytes.length)} bytes, expected ${String(ANDROID_OTA_HEADER_V2_BYTES)}`,
      ),
    );
  const manifestSize = u64be(bytes, 12);
  const metadataSignatureSize = u32be(bytes, 20);
  const size = asSafeUint(manifestSize, "manifest_size");
  if (!size.ok) return size;
  const manifestEnd = ANDROID_OTA_HEADER_V2_BYTES + size.value;
  const blobOffset = manifestEnd + metadataSignatureSize;
  if (!Number.isSafeInteger(blobOffset))
    return err(malformed("Android OTA payload header extents overflow"));
  if (fileSize < manifestEnd)
    return err(
      truncated(
        `Android OTA payload manifest is truncated: header declares ${String(size.value)} manifest bytes but the file ends at ${String(fileSize)}`,
      ),
    );
  if (size.value > ANDROID_OTA_MAX_MANIFEST_BYTES)
    return err(
      capacity("manifest size", ANDROID_OTA_MAX_MANIFEST_BYTES, "byte"),
    );
  const metadataSignatureFits = blobOffset <= fileSize;
  if (
    metadataSignatureFits &&
    metadataSignatureSize > ANDROID_OTA_MAX_SIGNATURE_BYTES
  )
    return err(
      capacity(
        "metadata signature size",
        ANDROID_OTA_MAX_SIGNATURE_BYTES,
        "byte",
      ),
    );
  return ok({
    magic: ANDROID_OTA_MAGIC,
    majorVersion: 2,
    manifestSize: size.value,
    metadataSignatureSize,
    manifestOffset: ANDROID_OTA_HEADER_V2_BYTES,
    metadataPrefixEnd: metadataSignatureFits ? blobOffset : manifestEnd,
    blobOffset,
  });
};

interface ExtentDraft {
  startBlock: number | null;
  numBlocks: number;
}

interface OperationDraft {
  hasType: boolean;
  typeCode: number;
  dataOffset: number;
  dataLength: number;
  dataHashHex: string | null;
  srcExtents: ExtentDraft[];
  dstExtents: ExtentDraft[];
}

interface PartitionInfoDraft {
  size: number | null;
  hashHex: string | null;
}

interface PartitionDraft {
  name: string | undefined;
  runPostinstall: boolean | null;
  postinstallPath: string | null;
  filesystemType: string | null;
  oldPartitionInfo: PartitionInfoDraft | null;
  newPartitionInfo: PartitionInfoDraft;
  operations: OperationDraft[];
  version: string | null;
  mergeOperationCount: number;
  estimateCowSize: number | null;
}

interface GroupDraft {
  name: string | undefined;
  size: number | null;
  partitionNames: string[];
}

interface ManifestDraft {
  blockSize: number;
  signaturesOffset: number | null;
  signaturesSize: number | null;
  minorVersion: number;
  partitions: PartitionDraft[];
  maxTimestamp: number | null;
  maxTimestampOutOfRange: boolean;
  partialUpdate: boolean | null;
  securityPatchLevel: string | null;
  groups: GroupDraft[];
  snapshotEnabled: boolean | null;
  vabcEnabled: boolean | null;
  vabcCompressionParam: string | null;
  hasDynamicMetadata: boolean;
  apex: AndroidOtaApexInfo[];
  operationTotal: number;
  groupPartitionNameTotal: { count: number };
}

const emptyPartitionInfo = (): PartitionInfoDraft => ({
  size: null,
  hashHex: null,
});

const decodeExtent = (
  bytes: Uint8Array,
): Result<ExtentDraft, AndroidOtaPayloadParseError> => {
  const extent: ExtentDraft = { startBlock: null, numBlocks: 0 };
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.Varint) {
      const start = toBigInt(reader.uint64());
      extent.startBlock =
        start === 0xffff_ffff_ffff_ffffn ? null : Number(start);
      if (
        extent.startBlock !== null &&
        !Number.isSafeInteger(extent.startBlock)
      )
        fail(
          malformed("extent start_block is not an exact nonnegative extent"),
        );
      return;
    }
    if (field === 2 && wire === WireType.Varint) {
      extent.numBlocks = unwrap(
        asSafeUint(reader.uint64(), "extent num_blocks"),
      );
      return;
    }
    reader.skip(wire);
  });
  return walked.ok ? ok(extent) : walked;
};

const decodePartitionInfo = (
  bytes: Uint8Array,
  info: PartitionInfoDraft,
): Result<PartitionInfoDraft, AndroidOtaPayloadParseError> => {
  // Protobuf singular messages merge across occurrences. Only fields present
  // in this occurrence replace earlier values; an empty message erases none.
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.Varint) {
      info.size = unwrap(asSafeUint(reader.uint64(), "partition size"));
      return;
    }
    if (field === 2 && wire === WireType.LengthDelimited) {
      info.hashHex = hex(reader.bytes());
      return;
    }
    reader.skip(wire);
  });
  return walked.ok ? ok(info) : walked;
};

const decodeOperation = (
  bytes: Uint8Array,
  extentTotal: { count: number },
): Result<OperationDraft, AndroidOtaPayloadParseError> => {
  const operation: OperationDraft = {
    hasType: false,
    typeCode: 0,
    dataOffset: 0,
    dataLength: 0,
    dataHashHex: null,
    srcExtents: [],
    dstExtents: [],
  };
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.Varint) {
      operation.hasType = true;
      operation.typeCode = reader.int32();
      if (operation.typeCode < 0)
        fail(malformed("InstallOperation type is negative"));
      return;
    }
    if (field === 2 && wire === WireType.Varint) {
      operation.dataOffset = unwrap(
        asSafeUint(reader.uint64(), "operation data_offset"),
      );
      return;
    }
    if (field === 3 && wire === WireType.Varint) {
      operation.dataLength = unwrap(
        asSafeUint(reader.uint64(), "operation data_length"),
      );
      return;
    }
    if ((field === 4 || field === 6) && wire === WireType.LengthDelimited) {
      if (extentTotal.count >= ANDROID_OTA_MAX_EXTENTS_TOTAL)
        fail(capacity("extent total", ANDROID_OTA_MAX_EXTENTS_TOTAL, "extent"));
      extentTotal.count += 1;
      (field === 4 ? operation.srcExtents : operation.dstExtents).push(
        unwrap(decodeExtent(reader.bytes())),
      );
      return;
    }
    if (field === 8 && wire === WireType.LengthDelimited) {
      const digest = reader.bytes();
      if (digest.length !== 0 && digest.length !== 32)
        fail(malformed("operation data_sha256_hash must be 32 bytes or empty"));
      operation.dataHashHex = digest.length === 0 ? null : hex(digest);
      return;
    }
    reader.skip(wire);
  });
  if (!walked.ok) return walked;
  if (!operation.hasType)
    return err(malformed("InstallOperation is missing type"));
  return ok(operation);
};

const decodePartition = (
  bytes: Uint8Array,
  operationTotal: { count: number },
  extentTotal: { count: number },
): Result<PartitionDraft, AndroidOtaPayloadParseError> => {
  const partition: PartitionDraft = {
    name: undefined,
    runPostinstall: null,
    postinstallPath: null,
    filesystemType: null,
    oldPartitionInfo: null,
    newPartitionInfo: emptyPartitionInfo(),
    operations: [],
    version: null,
    mergeOperationCount: 0,
    estimateCowSize: null,
  };
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) {
      partition.name = reader.string();
      return;
    }
    if (field === 2 && wire === WireType.Varint) {
      partition.runPostinstall = reader.bool();
      return;
    }
    if (field === 3 && wire === WireType.LengthDelimited) {
      partition.postinstallPath = reader.string();
      return;
    }
    if (field === 4 && wire === WireType.LengthDelimited) {
      partition.filesystemType = reader.string();
      return;
    }
    if (field === 6 && wire === WireType.LengthDelimited) {
      partition.oldPartitionInfo = unwrap(
        decodePartitionInfo(
          reader.bytes(),
          partition.oldPartitionInfo ?? emptyPartitionInfo(),
        ),
      );
      return;
    }
    if (field === 7 && wire === WireType.LengthDelimited) {
      partition.newPartitionInfo = unwrap(
        decodePartitionInfo(reader.bytes(), partition.newPartitionInfo),
      );
      return;
    }
    if (field === 8 && wire === WireType.LengthDelimited) {
      if (partition.operations.length >= ANDROID_OTA_MAX_OPERATIONS)
        fail(
          capacity(
            "operations per partition",
            ANDROID_OTA_MAX_OPERATIONS,
            "operation",
          ),
        );
      if (operationTotal.count >= ANDROID_OTA_MAX_OPERATIONS_TOTAL)
        fail(
          capacity(
            "operation total",
            ANDROID_OTA_MAX_OPERATIONS_TOTAL,
            "operation",
          ),
        );
      partition.operations.push(
        unwrap(decodeOperation(reader.bytes(), extentTotal)),
      );
      operationTotal.count += 1;
      return;
    }
    if (field === 17 && wire === WireType.LengthDelimited) {
      partition.version = reader.string();
      return;
    }
    if (field === 18 && wire === WireType.LengthDelimited) {
      reader.skip(wire);
      partition.mergeOperationCount += 1;
      return;
    }
    if (field === 19 && wire === WireType.Varint) {
      partition.estimateCowSize = unwrap(
        asSafeUint(reader.uint64(), "estimate_cow_size"),
      );
      return;
    }
    reader.skip(wire);
  });
  if (!walked.ok) {
    const cause = walked.error;
    return err(cause);
  }
  if (partition.name === undefined)
    return err(malformed("PartitionUpdate is missing partition_name"));
  return ok(partition);
};

const decodeGroup = (
  bytes: Uint8Array,
  partitionNameTotal: { count: number },
): Result<GroupDraft, AndroidOtaPayloadParseError> => {
  const group: GroupDraft = {
    name: undefined,
    size: null,
    partitionNames: [],
  };
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) {
      group.name = reader.string();
      return;
    }
    if (field === 2 && wire === WireType.Varint) {
      group.size = unwrap(
        asSafeUint(reader.uint64(), "dynamic partition group size"),
      );
      return;
    }
    if (field === 3 && wire === WireType.LengthDelimited) {
      if (partitionNameTotal.count >= ANDROID_OTA_MAX_GROUP_PARTITION_NAMES)
        fail(
          capacity(
            "dynamic partition group partition_names total",
            ANDROID_OTA_MAX_GROUP_PARTITION_NAMES,
            "name",
          ),
        );
      partitionNameTotal.count += 1;
      group.partitionNames.push(reader.string());
      return;
    }
    reader.skip(wire);
  });
  if (!walked.ok) return walked;
  if (group.name === undefined)
    return err(malformed("DynamicPartitionGroup is missing name"));
  return ok(group);
};

const decodeApex = (
  bytes: Uint8Array,
): Result<AndroidOtaApexInfo, AndroidOtaPayloadParseError> => {
  const apex: {
    packageName: string | null;
    version: number | null;
    isCompressed: boolean | null;
    decompressedSize: number | null;
  } = {
    packageName: null,
    version: null,
    isCompressed: null,
    decompressedSize: null,
  };
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) {
      apex.packageName = reader.string();
      return;
    }
    if (field === 2 && wire === WireType.Varint) {
      apex.version = asSafeInt(reader.int64());
      return;
    }
    if (field === 3 && wire === WireType.Varint) {
      apex.isCompressed = reader.bool();
      return;
    }
    if (field === 4 && wire === WireType.Varint) {
      apex.decompressedSize = asSafeInt(reader.int64());
      return;
    }
    reader.skip(wire);
  });
  return walked.ok ? ok(apex) : walked;
};

const decodeDynamicMetadata = (
  bytes: Uint8Array,
  draft: ManifestDraft,
): Result<undefined, AndroidOtaPayloadParseError> => {
  draft.hasDynamicMetadata = true;
  return walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) {
      if (draft.groups.length >= ANDROID_OTA_MAX_GROUPS)
        fail(
          capacity("dynamic partition groups", ANDROID_OTA_MAX_GROUPS, "group"),
        );
      draft.groups.push(
        unwrap(decodeGroup(reader.bytes(), draft.groupPartitionNameTotal)),
      );
      return;
    }
    if (field === 2 && wire === WireType.Varint) {
      draft.snapshotEnabled = reader.bool();
      return;
    }
    if (field === 3 && wire === WireType.Varint) {
      draft.vabcEnabled = reader.bool();
      return;
    }
    if (field === 4 && wire === WireType.LengthDelimited) {
      draft.vabcCompressionParam = reader.string();
      return;
    }
    reader.skip(wire);
  });
};

const countAndroidOtaSignatures = (
  bytes: Uint8Array,
): Result<number, AndroidOtaPayloadParseError> => {
  let count = 0;
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) {
      reader.skip(wire);
      count += 1;
      if (count > ANDROID_OTA_MAX_SIGNATURES)
        fail(
          capacity("signature count", ANDROID_OTA_MAX_SIGNATURES, "signature"),
        );
      return;
    }
    reader.skip(wire);
  });
  return walked.ok ? ok(count) : walked;
};

const decodeManifest = (
  bytes: Uint8Array,
): Result<ManifestDraft, AndroidOtaPayloadParseError> => {
  const draft: ManifestDraft = {
    blockSize: ANDROID_OTA_DEFAULT_BLOCK_SIZE,
    signaturesOffset: null,
    signaturesSize: null,
    minorVersion: 0,
    partitions: [],
    maxTimestamp: null,
    maxTimestampOutOfRange: false,
    partialUpdate: null,
    securityPatchLevel: null,
    groups: [],
    snapshotEnabled: null,
    vabcEnabled: null,
    vabcCompressionParam: null,
    hasDynamicMetadata: false,
    apex: [],
    operationTotal: 0,
    groupPartitionNameTotal: { count: 0 },
  };
  const operationTotal = { count: 0 };
  const extentTotal = { count: 0 };
  const walked = walk(bytes, (field, wire, reader) => {
    if (field === 3 && wire === WireType.Varint) {
      const size = unwrap(asSafeUint(reader.uint64(), "block_size"));
      if (size === 0) fail(malformed("manifest block_size is zero"));
      draft.blockSize = size;
      return;
    }
    if (field === 4 && wire === WireType.Varint) {
      draft.signaturesOffset = unwrap(
        asSafeUint(reader.uint64(), "signatures_offset"),
      );
      return;
    }
    if (field === 5 && wire === WireType.Varint) {
      draft.signaturesSize = unwrap(
        asSafeUint(reader.uint64(), "signatures_size"),
      );
      return;
    }
    if (field === 12 && wire === WireType.Varint) {
      draft.minorVersion = unwrap(asSafeUint(reader.uint64(), "minor_version"));
      return;
    }
    if (field === 13 && wire === WireType.LengthDelimited) {
      if (draft.partitions.length >= ANDROID_OTA_MAX_PARTITIONS)
        fail(
          capacity("partition count", ANDROID_OTA_MAX_PARTITIONS, "partition"),
        );
      draft.partitions.push(
        unwrap(decodePartition(reader.bytes(), operationTotal, extentTotal)),
      );
      return;
    }
    if (field === 14 && wire === WireType.Varint) {
      const timestamp = asSafeInt(reader.int64());
      if (timestamp === null) draft.maxTimestampOutOfRange = true;
      else draft.maxTimestamp = timestamp;
      return;
    }
    if (field === 15 && wire === WireType.LengthDelimited) {
      unwrap(decodeDynamicMetadata(reader.bytes(), draft));
      return;
    }
    if (field === 16 && wire === WireType.Varint) {
      draft.partialUpdate = reader.bool();
      return;
    }
    if (field === 17 && wire === WireType.LengthDelimited) {
      if (draft.apex.length >= ANDROID_OTA_MAX_APEX)
        fail(capacity("apex_info count", ANDROID_OTA_MAX_APEX, "entry"));
      draft.apex.push(unwrap(decodeApex(reader.bytes())));
      return;
    }
    if (field === 18 && wire === WireType.LengthDelimited) {
      draft.securityPatchLevel = reader.string();
      return;
    }
    reader.skip(wire);
  });
  if (!walked.ok) return walked;
  draft.operationTotal = operationTotal.count;
  return ok(draft);
};

interface PartitionNameState {
  readonly used: Set<string>;
  /** Next suffix to try per stem, so collision resolution stays linear. */
  readonly nextSuffix: Map<string, number>;
}

const partitionFileName = (
  name: string,
  index: number,
  state: PartitionNameState,
): string => {
  const stem =
    name.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "") ||
    `partition-${String(index)}`;
  const withExt = stem.endsWith(".img") ? stem : `${stem}.img`;
  let candidate = withExt;
  if (state.used.has(candidate)) {
    let suffix = state.nextSuffix.get(stem) ?? 1;
    do {
      candidate = `${stem}-${String(suffix)}.img`;
      suffix += 1;
    } while (state.used.has(candidate));
    state.nextSuffix.set(stem, suffix);
  }
  state.used.add(candidate);
  return candidate;
};

const operationCountsOf = (
  operations: readonly OperationDraft[],
): AndroidOtaPartition["operationCounts"] => {
  const counts = new Map<number, number>();
  for (const operation of operations)
    counts.set(operation.typeCode, (counts.get(operation.typeCode) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([type_code, count]) => ({
      type: INSTALL_OPERATION_NAMES[type_code] ?? "unknown",
      type_code,
      count,
    }));
};

const isExtractable = (operations: readonly OperationDraft[]): boolean =>
  operations.length > 0 &&
  operations.every((operation) => EXTRACTABLE_TYPES.has(operation.typeCode));

/** Decode the manifest and any complete metadata signature after the admitted header. */
export const parseAndroidOtaPayload = (
  header: AndroidOtaPayloadHeader,
  metadata: Uint8Array,
  fileSize: number,
): Result<AndroidOtaPayload, AndroidOtaPayloadParseError> => {
  if (metadata.length < header.manifestSize)
    return err(
      truncated(
        `Android OTA payload manifest is truncated: header declares ${String(header.manifestSize)} bytes starting at ${String(header.manifestOffset)}`,
      ),
    );
  const manifest = decodeManifest(metadata.subarray(0, header.manifestSize));
  if (!manifest.ok) return manifest;
  let metadataSignatureCount: number | null = null;
  const metadataBytes = header.metadataPrefixEnd - header.manifestOffset;
  if (metadataBytes > header.manifestSize && metadata.length >= metadataBytes) {
    const counted = countAndroidOtaSignatures(
      metadata.subarray(header.manifestSize, metadataBytes),
    );
    if (!counted.ok) return counted;
    metadataSignatureCount = counted.value;
  }
  // The manifest declares a payload signature only when both coordinates
  // are present. Keep each raw field available for inventory.
  const { signaturesOffset, signaturesSize } = manifest.value;
  const signatureDeclaration =
    signaturesOffset === null || signaturesSize === null
      ? null
      : { blobOffset: signaturesOffset, size: signaturesSize };
  let payloadSignatureRange: AndroidOtaPayload["payloadSignatureRange"] = null;
  let blobTruncated = fileSize < header.blobOffset;
  if (signatureDeclaration !== null) {
    const { blobOffset, size } = signatureDeclaration;
    const offset = header.blobOffset + blobOffset;
    const end = offset + size;
    if (!Number.isSafeInteger(end) || end > fileSize) blobTruncated = true;
    else {
      if (size > ANDROID_OTA_MAX_SIGNATURE_BYTES)
        return err(
          capacity(
            "payload signature size",
            ANDROID_OTA_MAX_SIGNATURE_BYTES,
            "byte",
          ),
        );
      if (size > 0) payloadSignatureRange = { offset, bytes: size };
    }
  }

  const blobAvailable = Math.max(0, fileSize - header.blobOffset);
  for (const partition of manifest.value.partitions) {
    for (const operation of partition.operations) {
      if (operation.dataLength === 0) continue;
      const end = operation.dataOffset + operation.dataLength;
      if (!Number.isSafeInteger(end) || end < operation.dataOffset)
        return err(malformed("operation data extent overflows"));
      if (
        signatureDeclaration !== null &&
        end > signatureDeclaration.blobOffset
      )
        return err(
          malformed(
            `operation data extent ${String(operation.dataOffset)}+${String(operation.dataLength)} overruns the ${String(signatureDeclaration.blobOffset)}-byte payload blob`,
          ),
        );
      if (end > blobAvailable) blobTruncated = true;
    }
  }

  const nameState: PartitionNameState = {
    used: new Set<string>(),
    nextSuffix: new Map<string, number>(),
  };
  const partitions: AndroidOtaPartition[] = manifest.value.partitions.map(
    (partition, index) => {
      const operations: AndroidOtaInstallOperation[] = partition.operations.map(
        (operation) => ({
          typeCode: operation.typeCode,
          typeName: INSTALL_OPERATION_NAMES[operation.typeCode] ?? "unknown",
          dataOffset: operation.dataOffset,
          dataLength: operation.dataLength,
          dataHashHex: operation.dataHashHex,
          srcExtents: operation.srcExtents.map((extent) => ({
            startBlock: extent.startBlock,
            numBlocks: extent.numBlocks,
          })),
          dstExtents: operation.dstExtents.map((extent) => ({
            startBlock: extent.startBlock,
            numBlocks: extent.numBlocks,
          })),
        }),
      );
      const needsBlob = operations.some(
        (operation) => operation.dataLength > 0,
      );
      const blobFits = operations.every(
        (operation) =>
          operation.dataLength === 0 ||
          operation.dataOffset + operation.dataLength <= blobAvailable,
      );
      const size = partition.newPartitionInfo.size;
      const extractRefusal: AndroidOtaExtractRefusal | null = !isExtractable(
        partition.operations,
      )
        ? "unsupported_operations"
        : size === null
          ? "missing_size"
          : size > ANDROID_OTA_MAX_EXTRACT_BYTES
            ? "size_limit"
            : needsBlob && !blobFits
              ? "blob_truncated"
              : null;
      return {
        index,
        name: partition.name!,
        path: partitionFileName(partition.name!, index, nameState),
        newPartitionInfo: {
          size: partition.newPartitionInfo.size,
          hashHex: partition.newPartitionInfo.hashHex,
        },
        oldPartitionInfo:
          partition.oldPartitionInfo === null
            ? null
            : {
                size: partition.oldPartitionInfo.size,
                hashHex: partition.oldPartitionInfo.hashHex,
              },
        version: partition.version,
        runPostinstall: partition.runPostinstall,
        postinstallPath: partition.postinstallPath,
        filesystemType: partition.filesystemType,
        operations,
        operationCounts: operationCountsOf(partition.operations),
        totalDataLength: operations.reduce(
          (total, operation) => total + operation.dataLength,
          0,
        ),
        mergeOperationCount: partition.mergeOperationCount,
        estimateCowSize: partition.estimateCowSize,
        extractable: extractRefusal === null,
        extractRefusal,
      };
    },
  );

  const limitations: string[] = [
    ANDROID_OTA_PAYLOAD_LIMITATIONS.inventoryScope,
    ANDROID_OTA_PAYLOAD_LIMITATIONS.signaturesUnverified,
  ];
  if (blobTruncated)
    limitations.push(ANDROID_OTA_PAYLOAD_LIMITATIONS.blobTruncated);
  for (const refusal of new Set(
    partitions.flatMap((partition) =>
      partition.extractRefusal === null ? [] : [partition.extractRefusal],
    ),
  ))
    limitations.push(androidOtaExtractRefusalLimitation(refusal));
  if (manifest.value.maxTimestampOutOfRange)
    limitations.push(
      "max_timestamp is outside the exact integer range this reader reports.",
    );

  return ok({
    header,
    fileSize,
    blockSize: manifest.value.blockSize,
    minorVersion: manifest.value.minorVersion,
    payloadKind: manifest.value.minorVersion === 0 ? "full" : "delta",
    maxTimestamp: manifest.value.maxTimestamp,
    partialUpdate: manifest.value.partialUpdate,
    securityPatchLevel: manifest.value.securityPatchLevel,
    signaturesOffset: manifest.value.signaturesOffset,
    signaturesSize: manifest.value.signaturesSize,
    metadataSignatureBlobSize: header.metadataSignatureSize,
    metadataSignatureCount,
    payloadSignatureBlobSize: signatureDeclaration?.size ?? null,
    payloadSignatureRange,
    payloadSignatureCount: null,
    partitions,
    dynamicPartitionGroups: manifest.value.groups.map((group) => ({
      name: group.name!,
      size: group.size,
      partitionNames: group.partitionNames,
    })),
    snapshotEnabled: manifest.value.hasDynamicMetadata
      ? manifest.value.snapshotEnabled
      : null,
    vabcEnabled: manifest.value.hasDynamicMetadata
      ? manifest.value.vabcEnabled
      : null,
    vabcCompressionParam: manifest.value.hasDynamicMetadata
      ? manifest.value.vabcCompressionParam
      : null,
    apexInfo: manifest.value.apex,
    blobTruncated,
    limitations,
  });
};

/** Count an admitted payload signature using the manifest facts already decoded. */
export const withAndroidOtaPayloadSignature = (
  payload: AndroidOtaPayload,
  signature: Uint8Array,
): Result<AndroidOtaPayload, AndroidOtaPayloadParseError> => {
  if (payload.payloadSignatureRange?.bytes !== signature.length)
    return err(
      malformed("payload signature blob length does not match signatures_size"),
    );
  const count = countAndroidOtaSignatures(signature);
  return count.ok
    ? ok({ ...payload, payloadSignatureCount: count.value })
    : count;
};

const writeExtents = (
  image: Buffer,
  extents: readonly AndroidOtaExtent[],
  blockSize: number,
  data: Uint8Array,
  fillZero: boolean,
): Result<undefined, AndroidOtaPayloadReconstructError> => {
  // The last block of a partition whose size is not block aligned may be
  // partially outside the image; every other destination byte must land
  // inside it, and every written byte must come from the operation data.
  const blockAlignedEnd = Math.ceil(image.length / blockSize) * blockSize;
  let cursor = 0;
  let span = 0;
  for (const extent of extents) {
    if (extent.numBlocks === 0) continue;
    if (extent.startBlock === null)
      return err(
        malformed("InstallOperation destination extent has no start_block"),
      );
    const start = extent.startBlock * blockSize;
    const extentBytes = extent.numBlocks * blockSize;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start >= image.length ||
      extentBytes > blockAlignedEnd - start
    )
      return err(
        malformed(
          "InstallOperation destination extent overruns the partition image",
        ),
      );
    const length = Math.min(extentBytes, image.length - start);
    span += extentBytes;
    if (fillZero) {
      image.fill(0, start, start + length);
      continue;
    }
    if (data.length - cursor < length)
      return err(
        malformed(
          "InstallOperation data is shorter than its destination extents",
        ),
      );
    image.set(data.subarray(cursor, cursor + length), start);
    cursor += extentBytes;
  }
  if (!fillZero && data.length > span)
    return err(
      malformed("InstallOperation data is longer than its destination extents"),
    );
  return ok(undefined);
};

const destinationExtentBytes = (
  extents: readonly AndroidOtaExtent[],
  blockSize: number,
): Result<number, AndroidOtaPayloadParseError> => {
  let total = 0;
  for (const extent of extents) {
    if (!Number.isSafeInteger(extent.numBlocks) || extent.numBlocks < 0)
      return err(
        capacity(
          "REPLACE_ZSTD decoded output",
          ANDROID_OTA_MAX_EXTRACT_BYTES,
          "byte",
        ),
      );
    if (
      extent.numBlocks > 0 &&
      blockSize > Math.floor(Number.MAX_SAFE_INTEGER / extent.numBlocks)
    )
      return err(
        capacity(
          "REPLACE_ZSTD decoded output",
          ANDROID_OTA_MAX_EXTRACT_BYTES,
          "byte",
        ),
      );
    const bytes = extent.numBlocks * blockSize;
    if (total > Number.MAX_SAFE_INTEGER - bytes)
      return err(
        capacity(
          "REPLACE_ZSTD decoded output",
          ANDROID_OTA_MAX_EXTRACT_BYTES,
          "byte",
        ),
      );
    total += bytes;
  }
  return ok(total);
};

/** Distinct operation blob bytes one partition open would retain. */
export const androidOtaDistinctOperationDataBytes = (
  operations: readonly AndroidOtaInstallOperation[],
): Result<number, AndroidOtaPayloadParseError> => {
  const seen = new Set<string>();
  let total = 0;
  for (const operation of operations) {
    if (operation.dataLength === 0) continue;
    const key = `${String(operation.dataOffset)}:${String(operation.dataLength)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      !Number.isSafeInteger(operation.dataLength) ||
      operation.dataLength < 0 ||
      total > Number.MAX_SAFE_INTEGER - operation.dataLength
    )
      return err(
        capacity(
          "partition operation data",
          ANDROID_OTA_MAX_OPERATION_DATA_BYTES,
          "byte",
        ),
      );
    total += operation.dataLength;
  }
  if (total > ANDROID_OTA_MAX_OPERATION_DATA_BYTES)
    return err(
      capacity(
        "partition operation data",
        ANDROID_OTA_MAX_OPERATION_DATA_BYTES,
        "byte",
      ),
    );
  return ok(total);
};

/** The typed failure for a partition the inventory refused to reconstruct. */
export const androidOtaExtractRefusalError = (
  partition: AndroidOtaPartition,
): AndroidOtaPayloadReconstructError | null => {
  switch (partition.extractRefusal) {
    case null:
      return null;
    case "unsupported_operations": {
      const unsupported = partition.operations.find(
        (operation) => !EXTRACTABLE_TYPES.has(operation.typeCode),
      );
      return {
        _tag: "AndroidOtaPayloadUnsupportedOperation",
        message: `Android OTA partition ${partition.name} uses unsupported operation ${unsupported?.typeName ?? "unknown"}`,
        typeCode: unsupported?.typeCode ?? -1,
      };
    }
    case "missing_size":
      return malformed(
        `Android OTA partition ${partition.name} has no new_partition_info size`,
      );
    case "size_limit":
      return capacity(
        "extracted partition size",
        ANDROID_OTA_MAX_EXTRACT_BYTES,
        "byte",
      );
    case "blob_truncated":
      return {
        _tag: "AndroidOtaPayloadBlobTruncated",
        message: `Android OTA partition ${partition.name} reads operation data past the end of the payload file`,
      };
  }
};

/**
 * Validate the block size and charge the whole reconstruction against one
 * budget before any work starts. Each operation decodes or writes up to its
 * destination extent bytes, and repeated blob references are decoded again
 * per operation, so a per-decode bound alone does not bound the loop.
 */
const chargeReconstructionWork = (
  operations: readonly AndroidOtaInstallOperation[],
  blockSize: number,
): Result<number, AndroidOtaPayloadParseError> => {
  if (blockSize <= 0 || !Number.isSafeInteger(blockSize))
    return err(malformed("block_size is not a positive extent"));
  let work = 0;
  for (const operation of operations) {
    const dstBytes = destinationExtentBytes(operation.dstExtents, blockSize);
    if (!dstBytes.ok) return dstBytes;
    work += dstBytes.value;
    if (work > ANDROID_OTA_MAX_EXTRACT_BYTES)
      return err(
        capacity(
          "partition reconstruction work",
          ANDROID_OTA_MAX_EXTRACT_BYTES,
          "byte",
        ),
      );
  }
  return ok(work);
};

const hasCompleteExtentCoverage = (
  operations: readonly AndroidOtaInstallOperation[],
  imageSize: number,
  blockSize: number,
): boolean => {
  const blockCount = Math.ceil(imageSize / blockSize);
  if (blockCount === 0) return true;
  const spans: [number, number][] = [];
  for (const operation of operations) {
    for (const extent of operation.dstExtents) {
      if (extent.numBlocks === 0) continue;
      if (extent.startBlock === null) return false;
      spans.push([extent.startBlock, extent.startBlock + extent.numBlocks]);
    }
  }
  spans.sort((left, right) => left[0] - right[0]);
  let coveredUntil = 0;
  for (const [start, end] of spans) {
    if (start > coveredUntil) return false;
    if (end > coveredUntil) coveredUntil = end;
    if (coveredUntil >= blockCount) return true;
  }
  return false;
};

/**
 * Rebuild a full-payload partition image after checking declared blob hashes.
 * A partition image hash mismatch fails unless `verifyDeclaredHash` is false,
 * which leaves that decision to a caller applying its own integrity policy.
 */
export const reconstructAndroidOtaPartition = (
  partition: AndroidOtaPartition,
  blockSize: number,
  readBlob: (offset: number, length: number) => Uint8Array,
  options: { readonly verifyDeclaredHash?: boolean } = {},
): Result<Uint8Array, AndroidOtaPayloadReconstructError> => {
  const refused = androidOtaExtractRefusalError(partition);
  if (refused !== null) return err(refused);
  const size = partition.newPartitionInfo.size!;
  const budget = chargeReconstructionWork(partition.operations, blockSize);
  if (!budget.ok) return budget;
  const image = Buffer.alloc(size);
  // The reader shares one byte array for repeated references to the same blob.
  const blobHashes = new WeakMap<Uint8Array, string>();
  try {
    for (const [index, operation] of partition.operations.entries()) {
      if (operation.typeCode === 6) {
        const written = writeExtents(
          image,
          operation.dstExtents,
          blockSize,
          new Uint8Array(),
          true,
        );
        if (!written.ok) return written;
        continue;
      }
      const raw =
        operation.dataLength === 0
          ? new Uint8Array()
          : readBlob(operation.dataOffset, operation.dataLength);
      if (raw.length !== operation.dataLength)
        return err(
          truncated(
            `operation data for ${partition.name} is truncated: expected ${String(operation.dataLength)} bytes`,
          ),
        );
      if (operation.dataHashHex !== null) {
        const observed = blobHashes.get(raw) ?? sha256Hex(raw);
        blobHashes.set(raw, observed);
        if (operation.dataHashHex !== observed)
          return err({
            _tag: "AndroidOtaPayloadIntegrityFailure",
            message: `Android OTA partition ${partition.name} operation ${String(index)} data hash mismatch`,
            declaredHashHex: operation.dataHashHex,
            observedHashHex: observed,
          });
      }
      let payload: Uint8Array = raw;
      if (operation.typeCode === 14) {
        const dstBytes = destinationExtentBytes(
          operation.dstExtents,
          blockSize,
        );
        if (!dstBytes.ok) return dstBytes;
        const maxOutputLength = Math.max(
          1,
          Math.min(dstBytes.value, ANDROID_OTA_MAX_EXTRACT_BYTES),
        );
        try {
          payload = zstdDecompressSync(raw, { maxOutputLength });
        } catch (cause: unknown) {
          return err(
            hostRangeErrorKind(cause) === "host-capacity"
              ? capacity("REPLACE_ZSTD decoded output", maxOutputLength, "byte")
              : malformed(
                  "REPLACE_ZSTD operation payload is not a valid Zstandard frame",
                ),
          );
        }
      }
      const written = writeExtents(
        image,
        operation.dstExtents,
        blockSize,
        payload,
        false,
      );
      if (!written.ok) return written;
    }
  } catch (cause: unknown) {
    return err(
      malformed(
        cause instanceof Error
          ? `Android OTA partition ${partition.name} could not be reconstructed: ${cause.message}`
          : `Android OTA partition ${partition.name} could not be reconstructed`,
      ),
    );
  }
  if (!hasCompleteExtentCoverage(partition.operations, size, blockSize))
    return err(
      malformed(
        `Android OTA partition ${partition.name} destination extents do not cover the full ${String(size)}-byte image`,
      ),
    );
  if (options.verifyDeclaredHash === false) return ok(image);
  const observed = sha256Hex(image);
  const declared = partition.newPartitionInfo.hashHex;
  if (declared !== null && declared !== observed)
    return err({
      _tag: "AndroidOtaPayloadIntegrityFailure",
      message: `Android OTA partition ${partition.name} hash mismatch`,
      declaredHashHex: declared,
      observedHashHex: observed,
    });
  return ok(image);
};
