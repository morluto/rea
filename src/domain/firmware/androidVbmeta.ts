import { sha256Hex } from "../../kernel/sha256Hex.js";
import type {
  AndroidVbmetaDescriptor,
  AndroidVbmetaMetadata,
} from "../artifactFormatMetadata.js";
import { BinaryReader } from "../binaryContainer.js";
import { boundedList, describeBoundedList } from "../boundedList.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
  type LimitRef,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { decodeStrictUtf8 } from "../strictUtf8.js";

/** Four-byte magic at offset 0 of a standalone vbmeta image. */
export const AVB_MAGIC = "AVB0";
const AVB_MAGIC_BYTES = Buffer.from(AVB_MAGIC);
/** Fixed vbmeta header size, including the release string and reserved tail. */
export const AVB_HEADER_SIZE = 256;
const AVB_RELEASE_STRING_SIZE = 48;
const AVB_BLOCK_ALIGNMENT = 64;
const AVB_DESCRIPTOR_ALIGNMENT = 8;

/**
 * Authentication-block ceiling. RSA-8192 signatures are 1024 bytes; the
 * ceiling leaves room for the hash and 64-byte padding.
 */
export const AVB_MAX_AUTHENTICATION_BLOCK_BYTES = 64 * 1024;
/**
 * Auxiliary-block ceiling. A public key, its metadata, and the descriptor
 * table together stay inside this bound before any of those bytes are read.
 */
export const AVB_MAX_AUXILIARY_BLOCK_BYTES = 2 * 1024 * 1024;
/** Descriptor-table ceiling, inside the auxiliary block. */
export const AVB_MAX_DESCRIPTOR_BYTES = 1024 * 1024;
/** Descriptor-count ceiling. Each descriptor is walked before the next. */
export const AVB_MAX_DESCRIPTORS = 4096;
/** Distinct unknown descriptor tags named in the aggregate limitation. */
export const AVB_UNKNOWN_TAGS_NAMED = 8;
/** The only required libavb major version whose layout this reader knows. */
const AVB_SUPPORTED_MAJOR = 1;

export const AVB_ALGORITHM = {
  NONE: 0,
  SHA256_RSA2048: 1,
  SHA256_RSA4096: 2,
  SHA256_RSA8192: 3,
  SHA512_RSA2048: 4,
  SHA512_RSA4096: 5,
  SHA512_RSA8192: 6,
} as const;

const ALGORITHM_NAMES = [
  "NONE",
  "SHA256_RSA2048",
  "SHA256_RSA4096",
  "SHA256_RSA8192",
  "SHA512_RSA2048",
  "SHA512_RSA4096",
  "SHA512_RSA8192",
] as const;

export const AVB_HEADER_FLAG = {
  HASHTREE_DISABLED: 0x1,
  VERIFICATION_DISABLED: 0x2,
} as const;

export const AVB_HASHTREE_FLAG = {
  DO_NOT_USE_AB: 0x1,
  CHECK_AT_MOST_ONCE: 0x2,
} as const;

export const AVB_HASH_FLAG = {
  DO_NOT_USE_AB: 0x1,
} as const;

export const AVB_CHAIN_PARTITION_FLAG = {
  DO_NOT_USE_AB: 0x1,
} as const;

export const AVB_KERNEL_CMDLINE_FLAG = {
  USE_ONLY_IF_HASHTREE_NOT_DISABLED: 0x1,
  USE_ONLY_IF_HASHTREE_DISABLED: 0x2,
} as const;

export const AVB_DESCRIPTOR_TAG = {
  PROPERTY: 0,
  HASHTREE: 1,
  HASH: 2,
  KERNEL_CMDLINE: 3,
  CHAIN_PARTITION: 4,
} as const;

const HEADER_FLAGS: readonly (readonly [number, string])[] = [
  [AVB_HEADER_FLAG.HASHTREE_DISABLED, "HASHTREE_DISABLED"],
  [AVB_HEADER_FLAG.VERIFICATION_DISABLED, "VERIFICATION_DISABLED"],
];
const HASHTREE_FLAGS: readonly (readonly [number, string])[] = [
  [AVB_HASHTREE_FLAG.DO_NOT_USE_AB, "DO_NOT_USE_AB"],
  [AVB_HASHTREE_FLAG.CHECK_AT_MOST_ONCE, "CHECK_AT_MOST_ONCE"],
];
const HASH_FLAGS: readonly (readonly [number, string])[] = [
  [AVB_HASH_FLAG.DO_NOT_USE_AB, "DO_NOT_USE_AB"],
];
const CHAIN_FLAGS: readonly (readonly [number, string])[] = [
  [AVB_CHAIN_PARTITION_FLAG.DO_NOT_USE_AB, "DO_NOT_USE_AB"],
];
const CMDLINE_FLAGS: readonly (readonly [number, string])[] = [
  [
    AVB_KERNEL_CMDLINE_FLAG.USE_ONLY_IF_HASHTREE_NOT_DISABLED,
    "USE_ONLY_IF_HASHTREE_NOT_DISABLED",
  ],
  [
    AVB_KERNEL_CMDLINE_FLAG.USE_ONLY_IF_HASHTREE_DISABLED,
    "USE_ONLY_IF_HASHTREE_DISABLED",
  ],
];

const FORMAT = "android-vbmeta";

const AUTHENTICATION_BLOCK_LIMIT = {
  name: "Android vbmeta authentication block",
  maximum: AVB_MAX_AUTHENTICATION_BLOCK_BYTES,
  unit: "bytes",
};
const AUXILIARY_BLOCK_LIMIT = {
  name: "Android vbmeta auxiliary block",
  maximum: AVB_MAX_AUXILIARY_BLOCK_BYTES,
  unit: "bytes",
};
const DESCRIPTOR_BYTES_LIMIT = {
  name: "Android vbmeta descriptor bytes",
  maximum: AVB_MAX_DESCRIPTOR_BYTES,
  unit: "bytes",
};
const DESCRIPTOR_COUNT_LIMIT = {
  name: "Android vbmeta descriptor count",
  maximum: AVB_MAX_DESCRIPTORS,
  unit: "descriptors",
};

/** Parser-owned fixed ceilings and their units for artifact recovery. */
export const ANDROID_VBMETA_FIXED_LIMITS: ReadonlyMap<
  string,
  LimitRef & { readonly unit: string }
> = new Map([
  [AUTHENTICATION_BLOCK_LIMIT.name, AUTHENTICATION_BLOCK_LIMIT],
  [AUXILIARY_BLOCK_LIMIT.name, AUXILIARY_BLOCK_LIMIT],
  [DESCRIPTOR_BYTES_LIMIT.name, DESCRIPTOR_BYTES_LIMIT],
  [DESCRIPTOR_COUNT_LIMIT.name, DESCRIPTOR_COUNT_LIMIT],
]);

export const ANDROID_VBMETA_LIMITATIONS = {
  unverified:
    "Signatures, hashes, and hashtree digests are recorded and not verified.",
  untrusted:
    "Release strings, property values, kernel command lines, and partition names are target-derived and untrusted.",
} as const;

/** How parsing a vbmeta image failed. */
export type AndroidVbmetaParseError = ParseFailureError;

/** One stored range the reader exposes as a child. */
export interface AndroidVbmetaChild {
  readonly path: "authentication_block" | "public_key" | "public_key_metadata";
  readonly role: "authentication-block" | "public-key" | "public-key-metadata";
  readonly offset: number;
  readonly size: number;
}

/**
 * Header, descriptors, and the non-empty stored ranges. When a malformed
 * descriptor stopped the walk, `metadata.descriptor_failure` names it and
 * `metadata.descriptors` holds the decoded prefix.
 */
export interface AndroidVbmetaImage {
  readonly metadata: Omit<AndroidVbmetaMetadata, "kind">;
  readonly layoutSupported: boolean;
  readonly children: readonly AndroidVbmetaChild[];
  readonly limitations: readonly string[];
  readonly imageSize: number;
}

/** True when the first four bytes are AVB0. */
export const hasAndroidVbmetaMagic = (prefix: Buffer): boolean =>
  prefix.length >= 4 && prefix.subarray(0, 4).equals(AVB_MAGIC_BYTES);

const caught = <T>(read: () => T): Result<T, AndroidVbmetaParseError> => {
  try {
    return ok(read());
  } catch (cause) {
    if (!(cause instanceof ParseFailureError)) throw cause;
    return err(cause);
  }
};

const malformed = (detail: string, field?: string, offset?: number): never => {
  throw malformedInput(FORMAT, detail, {
    ...(field === undefined ? {} : { field }),
    ...(offset === undefined ? {} : { offset }),
  });
};

const truncated = (detail: string, field: string, offset: number): never => {
  throw truncatedInput(FORMAT, detail, { field, offset });
};

const capacity = (
  detail: string,
  limit: { readonly name: string; readonly maximum: number },
  field: string,
  offset: number,
): never => {
  throw decodeLimit(FORMAT, detail, limit, { field, offset });
};

const requireFileSize = (fileSize: number): void => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    malformed("file size is not a safe nonnegative integer", "file_size");
};

const u32 = (bytes: Buffer, offset: number): number =>
  new BinaryReader(bytes, false, FORMAT).u32(offset);

const u64 = (bytes: Buffer, offset: number): bigint =>
  new BinaryReader(bytes, false, FORMAT).word(offset, 64);

const u64Capped = (
  bytes: Buffer,
  offset: number,
  field: string,
  maximum: number,
  limit: { readonly name: string; readonly maximum: number },
): number => {
  const value = u64(bytes, offset);
  if (value > BigInt(maximum))
    capacity(
      `${field} of ${value.toString()} bytes exceeds the fixed ${String(maximum)}-byte ceiling`,
      limit,
      field,
      offset,
    );
  return Number(value);
};

/** Metadata-only u64, never used to address bytes, kept as a decimal string. */
const u64Decimal = (bytes: Buffer, offset: number): string =>
  u64(bytes, offset).toString();

const u64Safe = (
  bytes: Buffer,
  offset: number,
  field: string,
  carrierBase = 0,
): number => {
  const value = u64(bytes, offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    malformed(`${field} exceeds a safe integer`, field, carrierBase + offset);
  return Number(value);
};

const rangeInside = (
  start: number,
  size: number,
  block: number,
  field: string,
  offsetField: number,
): void => {
  if (start > block || size > block - start)
    malformed(
      `${field} extends past its block`,
      field,
      start > block ? offsetField : offsetField + 8,
    );
};

const requireBlockAligned = (size: number, field: string): void => {
  if (size % AVB_BLOCK_ALIGNMENT !== 0)
    malformed(`${field} size ${String(size)} is not a multiple of 64`, field);
};

const flagNames = (
  flags: number,
  table: readonly (readonly [number, string])[],
): string[] => {
  const bits = flags >>> 0;
  const names = table
    .filter(([bit]) => (bits & bit) !== 0)
    .map(([, name]) => name);
  const known = table.reduce((mask, [bit]) => mask | bit, 0);
  const unknown = (bits & ~known) >>> 0;
  if (unknown !== 0) names.push(`0x${unknown.toString(16)}`);
  return names;
};

const decodeText = (bytes: Buffer): string | null => {
  try {
    return decodeStrictUtf8(bytes, "preserve");
  } catch {
    return null;
  }
};

const textField = (
  bytes: Buffer,
): { readonly text: string | null; readonly hex: string } => ({
  text: decodeText(bytes),
  hex: bytes.toString("hex"),
});

/** NUL-terminated fixed field. The hex is the whole field, including padding. */
const cStringField = (
  field: Buffer,
  name: string,
  at: number,
): { readonly text: string | null; readonly hex: string } => {
  const nul = field.indexOf(0);
  if (nul === -1) malformed(`${name} is not NUL-terminated`, name, at);
  return {
    text: decodeText(field.subarray(0, nul)),
    hex: field.toString("hex"),
  };
};

const nonzero = (bytes: Buffer): boolean => bytes.some((byte) => byte !== 0);

interface HeaderFields {
  readonly major: number;
  readonly minor: number;
  readonly authenticationSize: number;
  readonly auxiliarySize: number;
  readonly algorithmType: number;
  readonly hashOffset: number;
  readonly hashSize: number;
  readonly signatureOffset: number;
  readonly signatureSize: number;
  readonly publicKeyOffset: number;
  readonly publicKeySize: number;
  readonly publicKeyMetadataOffset: number;
  readonly publicKeyMetadataSize: number;
  readonly descriptorsOffset: number;
  readonly descriptorsSize: number;
  readonly rollbackIndex: string;
  readonly flags: number;
  readonly rollbackIndexLocation: number;
  readonly release: { readonly text: string | null; readonly hex: string };
  readonly imageSize: number;
  readonly reservedNonZero: boolean;
}

/**
 * Read the 256-byte header and accept its block sizes. The caller reads the
 * image body only after this returns, so an oversize block is a limit rather
 * than a read.
 */
export const androidVbmetaImageExtent = (
  bytes: Buffer,
  fileSize: number,
): Result<HeaderFields, AndroidVbmetaParseError> =>
  caught(() => {
    requireFileSize(fileSize);
    if (bytes.length < AVB_HEADER_SIZE)
      truncated(
        `header is truncated: ${String(bytes.length)} bytes available, 256 required`,
        "header",
        bytes.length,
      );
    if (!hasAndroidVbmetaMagic(bytes))
      malformed("magic is not AVB0", "magic", 0);
    const authenticationSize = u64Capped(
      bytes,
      12,
      "authentication block",
      AVB_MAX_AUTHENTICATION_BLOCK_BYTES,
      AUTHENTICATION_BLOCK_LIMIT,
    );
    const auxiliarySize = u64Capped(
      bytes,
      20,
      "auxiliary block",
      AVB_MAX_AUXILIARY_BLOCK_BYTES,
      AUXILIARY_BLOCK_LIMIT,
    );
    requireBlockAligned(authenticationSize, "authentication block");
    requireBlockAligned(auxiliarySize, "auxiliary block");
    const hashOffset = u64Safe(bytes, 32, "hash offset");
    const hashSize = u64Safe(bytes, 40, "hash size");
    const signatureOffset = u64Safe(bytes, 48, "signature offset");
    const signatureSize = u64Safe(bytes, 56, "signature size");
    const publicKeyOffset = u64Safe(bytes, 64, "public key offset");
    const publicKeySize = u64Safe(bytes, 72, "public key size");
    const publicKeyMetadataOffset = u64Safe(
      bytes,
      80,
      "public key metadata offset",
    );
    const publicKeyMetadataSize = u64Safe(
      bytes,
      88,
      "public key metadata size",
    );
    const descriptorsOffset = u64Safe(bytes, 96, "descriptors offset");
    const descriptorsSize = u64Capped(
      bytes,
      104,
      "descriptor bytes",
      AVB_MAX_DESCRIPTOR_BYTES,
      DESCRIPTOR_BYTES_LIMIT,
    );
    rangeInside(hashOffset, hashSize, authenticationSize, "hash", 32);
    rangeInside(
      signatureOffset,
      signatureSize,
      authenticationSize,
      "signature",
      48,
    );
    rangeInside(
      publicKeyOffset,
      publicKeySize,
      auxiliarySize,
      "public key",
      64,
    );
    rangeInside(
      publicKeyMetadataOffset,
      publicKeyMetadataSize,
      auxiliarySize,
      "public key metadata",
      80,
    );
    rangeInside(
      descriptorsOffset,
      descriptorsSize,
      auxiliarySize,
      "descriptors",
      96,
    );
    const imageSize = AVB_HEADER_SIZE + authenticationSize + auxiliarySize;
    if (imageSize > fileSize)
      truncated(
        `image is truncated: vbmeta ends at byte ${String(imageSize)} but the file is ${String(fileSize)} bytes`,
        "image",
        fileSize,
      );
    // libavb rejects a header unless the release field's last byte is NUL.
    const releaseEnd = 128 + AVB_RELEASE_STRING_SIZE - 1;
    if (bytes[releaseEnd] !== 0)
      malformed(
        "release string is not NUL-terminated in its final byte",
        "release string",
        releaseEnd,
      );
    const release = cStringField(
      bytes.subarray(128, 128 + AVB_RELEASE_STRING_SIZE),
      "release string",
      128,
    );
    return {
      major: u32(bytes, 4),
      minor: u32(bytes, 8),
      authenticationSize,
      auxiliarySize,
      algorithmType: u32(bytes, 28),
      hashOffset,
      hashSize,
      signatureOffset,
      signatureSize,
      publicKeyOffset,
      publicKeySize,
      publicKeyMetadataOffset,
      publicKeyMetadataSize,
      descriptorsOffset,
      descriptorsSize,
      rollbackIndex: u64Decimal(bytes, 112),
      flags: u32(bytes, 120),
      rollbackIndexLocation: u32(bytes, 124),
      release,
      imageSize,
      reservedNonZero: nonzero(bytes.subarray(176, AVB_HEADER_SIZE)),
    };
  });

const requireBody = (
  body: Buffer,
  fixed: number,
  field: string,
  at: number,
): void => {
  if (body.length < fixed)
    malformed(
      `${field} descriptor is shorter than its fixed header`,
      field,
      at,
    );
};

interface DeclaredLength {
  readonly length: number;
  readonly field: string;
  /** Offset of the length field within the descriptor body. */
  readonly bodyOffset: number;
}

// The descriptor body starts after the 8-byte tag and 8-byte
// num_bytes_following fields, so body offsets map to file offsets at + 16.
const tailParts = (
  body: Buffer,
  fixed: number,
  lengths: readonly DeclaredLength[],
  descriptor: string,
  at: number,
): Buffer[] => {
  let cursor = fixed;
  const parts: Buffer[] = [];
  for (const { length, field, bodyOffset } of lengths) {
    if (cursor > body.length || length > body.length - cursor)
      malformed(
        `${descriptor} descriptor ${field} extends past the descriptor`,
        field,
        at + 16 + bodyOffset,
      );
    parts.push(body.subarray(cursor, cursor + length));
    cursor += length;
  }
  if (body.length - cursor >= AVB_DESCRIPTOR_ALIGNMENT)
    malformed(
      `${descriptor} descriptor padding is not smaller than 8 bytes`,
      "num_bytes_following",
      at + 8,
    );
  return parts;
};

const partitionName = (
  bytes: Buffer,
): { readonly text: string | null; readonly hex: string } => textField(bytes);

const parseProperty = (body: Buffer, at: number): AndroidVbmetaDescriptor => {
  requireBody(body, 16, "property", at);
  const keyLength = u64Safe(body, 0, "property key length", at + 16);
  const valueLength = u64Safe(body, 8, "property value length", at + 16);
  const keyStart = 16;
  if (keyLength > body.length - keyStart)
    malformed("property key extends past the descriptor", "property", at + 16);
  const keyNul = keyStart + keyLength;
  if (keyNul >= body.length || body[keyNul] !== 0)
    malformed(
      "property key is not NUL-terminated",
      "property",
      at + 16 + keyNul,
    );
  const valueStart = keyNul + 1;
  if (valueLength > body.length - valueStart)
    malformed(
      "property value extends past the descriptor",
      "property",
      at + 24,
    );
  const valueNul = valueStart + valueLength;
  if (valueNul >= body.length || body[valueNul] !== 0)
    malformed(
      "property value is not NUL-terminated",
      "property",
      at + 16 + valueNul,
    );
  if (body.length - (valueNul + 1) >= AVB_DESCRIPTOR_ALIGNMENT)
    malformed(
      "property descriptor padding is not smaller than 8 bytes",
      "property",
      at,
    );
  const key = textField(body.subarray(keyStart, keyNul));
  const value = textField(body.subarray(valueStart, valueNul));
  return {
    tag: AVB_DESCRIPTOR_TAG.PROPERTY,
    tag_name: "PROPERTY",
    offset: at,
    num_bytes_following: body.length,
    key: key.text,
    key_bytes_hex: key.hex,
    value: value.text,
    value_bytes_hex: value.hex,
  };
};

const parseHashtree = (
  body: Buffer,
  at: number,
): {
  readonly descriptor: AndroidVbmetaDescriptor;
  readonly reserved: Buffer;
} => {
  requireBody(body, 164, "hashtree", at);
  const nameLength = u32(body, 88);
  const saltLength = u32(body, 92);
  const digestLength = u32(body, 96);
  const [name, salt, digest] = tailParts(
    body,
    164,
    [
      { length: nameLength, field: "partition name length", bodyOffset: 88 },
      { length: saltLength, field: "salt length", bodyOffset: 92 },
      { length: digestLength, field: "root digest length", bodyOffset: 96 },
    ],
    "hashtree",
    at,
  );
  const algorithm = cStringField(
    body.subarray(56, 88),
    "hash algorithm",
    at + 16 + 56,
  );
  const partition = partitionName(name!);
  return {
    reserved: body.subarray(104, 164),
    descriptor: {
      tag: AVB_DESCRIPTOR_TAG.HASHTREE,
      tag_name: "HASHTREE",
      offset: at,
      num_bytes_following: body.length,
      partition_name: partition.text,
      partition_name_bytes_hex: partition.hex,
      dm_verity_version: u32(body, 0),
      image_size: u64Decimal(body, 4),
      tree_offset: u64Decimal(body, 12),
      tree_size: u64Decimal(body, 20),
      data_block_size: u32(body, 28),
      hash_block_size: u32(body, 32),
      fec_num_roots: u32(body, 36),
      fec_offset: u64Decimal(body, 40),
      fec_size: u64Decimal(body, 48),
      hash_algorithm: algorithm.text,
      hash_algorithm_bytes_hex: algorithm.hex,
      salt_hex: salt!.toString("hex"),
      root_digest_hex: digest!.toString("hex"),
      flags: u32(body, 100),
      flag_names: flagNames(u32(body, 100), HASHTREE_FLAGS),
    },
  };
};

const parseHash = (
  body: Buffer,
  at: number,
): {
  readonly descriptor: AndroidVbmetaDescriptor;
  readonly reserved: Buffer;
} => {
  requireBody(body, 116, "hash", at);
  const nameLength = u32(body, 40);
  const saltLength = u32(body, 44);
  const digestLength = u32(body, 48);
  const [name, salt, digest] = tailParts(
    body,
    116,
    [
      { length: nameLength, field: "partition name length", bodyOffset: 40 },
      { length: saltLength, field: "salt length", bodyOffset: 44 },
      { length: digestLength, field: "digest length", bodyOffset: 48 },
    ],
    "hash",
    at,
  );
  const algorithm = cStringField(
    body.subarray(8, 40),
    "hash algorithm",
    at + 16 + 8,
  );
  const partition = partitionName(name!);
  const flags = u32(body, 52);
  return {
    reserved: body.subarray(56, 116),
    descriptor: {
      tag: AVB_DESCRIPTOR_TAG.HASH,
      tag_name: "HASH",
      offset: at,
      num_bytes_following: body.length,
      partition_name: partition.text,
      partition_name_bytes_hex: partition.hex,
      image_size: u64Decimal(body, 0),
      hash_algorithm: algorithm.text,
      hash_algorithm_bytes_hex: algorithm.hex,
      salt_hex: salt!.toString("hex"),
      digest_hex: digest!.toString("hex"),
      flags,
      flag_names: flagNames(flags, HASH_FLAGS),
    },
  };
};

const parseCmdline = (body: Buffer, at: number): AndroidVbmetaDescriptor => {
  requireBody(body, 8, "kernel cmdline", at);
  const flags = u32(body, 0);
  const length = u32(body, 4);
  const [cmdline] = tailParts(
    body,
    8,
    [{ length, field: "kernel cmdline length", bodyOffset: 4 }],
    "kernel cmdline",
    at,
  );
  const text = textField(cmdline!);
  return {
    tag: AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE,
    tag_name: "KERNEL_CMDLINE",
    offset: at,
    num_bytes_following: body.length,
    flags,
    flag_names: flagNames(flags, CMDLINE_FLAGS),
    cmdline: text.text,
    cmdline_bytes_hex: text.hex,
  };
};

const parseChain = (
  body: Buffer,
  at: number,
): {
  readonly descriptor: AndroidVbmetaDescriptor;
  readonly reserved: Buffer;
} => {
  requireBody(body, 76, "chain partition", at);
  const rollbackIndexLocation = u32(body, 0);
  // libavb's chain descriptor validator requires a location of at least 1.
  if (rollbackIndexLocation < 1)
    malformed(
      "chain partition rollback index location is 0; libavb requires at least 1",
      "rollback index location",
      at + 16,
    );
  const nameLength = u32(body, 4);
  const keyLength = u32(body, 8);
  const [name, key] = tailParts(
    body,
    76,
    [
      { length: nameLength, field: "partition name length", bodyOffset: 4 },
      { length: keyLength, field: "public key length", bodyOffset: 8 },
    ],
    "chain partition",
    at,
  );
  const partition = partitionName(name!);
  const flags = u32(body, 12);
  return {
    reserved: body.subarray(16, 76),
    descriptor: {
      tag: AVB_DESCRIPTOR_TAG.CHAIN_PARTITION,
      tag_name: "CHAIN_PARTITION",
      offset: at,
      num_bytes_following: body.length,
      rollback_index_location: rollbackIndexLocation,
      partition_name: partition.text,
      partition_name_bytes_hex: partition.hex,
      public_key_size: keyLength,
      public_key_sha256: sha256Hex(key!),
      flags,
      flag_names: flagNames(flags, CHAIN_FLAGS),
    },
  };
};

const parseDescriptor = (
  tag: bigint,
  body: Buffer,
  at: number,
): {
  readonly descriptor: AndroidVbmetaDescriptor;
  readonly reservedNonZero: boolean;
} => {
  if (tag === BigInt(AVB_DESCRIPTOR_TAG.PROPERTY))
    return { descriptor: parseProperty(body, at), reservedNonZero: false };
  if (tag === BigInt(AVB_DESCRIPTOR_TAG.HASHTREE)) {
    const parsed = parseHashtree(body, at);
    return {
      descriptor: parsed.descriptor,
      reservedNonZero: nonzero(parsed.reserved),
    };
  }
  if (tag === BigInt(AVB_DESCRIPTOR_TAG.HASH)) {
    const parsed = parseHash(body, at);
    return {
      descriptor: parsed.descriptor,
      reservedNonZero: nonzero(parsed.reserved),
    };
  }
  if (tag === BigInt(AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE))
    return { descriptor: parseCmdline(body, at), reservedNonZero: false };
  if (tag === BigInt(AVB_DESCRIPTOR_TAG.CHAIN_PARTITION)) {
    const parsed = parseChain(body, at);
    return {
      descriptor: parsed.descriptor,
      reservedNonZero: nonzero(parsed.reserved),
    };
  }
  return {
    descriptor: {
      tag: tag.toString(),
      tag_name: "UNKNOWN",
      offset: at,
      num_bytes_following: body.length,
    },
    reservedNonZero: false,
  };
};

/**
 * One limitation for every unknown descriptor. It names at most
 * AVB_UNKNOWN_TAGS_NAMED distinct tags and counts the rest; each descriptor's
 * tag and offset stay in the descriptor Evidence.
 */
const unknownTagsLimitation = (
  count: number,
  tags: ReadonlySet<string>,
): string => {
  const named = describeBoundedList(
    boundedList([...tags], AVB_UNKNOWN_TAGS_NAMED),
    ", ",
  );
  const subject =
    count === 1
      ? "1 descriptor with an unknown AVB tag"
      : `${String(count)} descriptors with unknown AVB tags`;
  return `${subject} (${named}) ${count === 1 ? "is" : "are"} retained with ${count === 1 ? "its" : "their"} tag, size, and file offset.`;
};

/** Where a descriptor walk stopped on a malformed descriptor. */
export interface AndroidVbmetaDescriptorFailure {
  readonly kind: "malformed" | "truncated";
  readonly detail: string;
  readonly field: string | null;
  /** File offset of the failing structure, or of its descriptor when unnamed. */
  readonly offset: number;
  /** File offset of the descriptor the walk could not decode. */
  readonly descriptor_offset: number;
  /** Descriptor-table bytes from that descriptor on, none of them decoded. */
  readonly unexamined_bytes: number;
}

const descriptorFailureLimitation = (
  failure: AndroidVbmetaDescriptorFailure,
  decoded: number,
): string =>
  `Descriptor walk stopped at file offset ${String(failure.descriptor_offset)}: ${failure.detail}. ${decoded === 1 ? "The 1 descriptor" : `The ${String(decoded)} descriptors`} before it ${decoded === 1 ? "is" : "are"} decoded; the remaining ${String(failure.unexamined_bytes)} bytes of the descriptor table were not examined.`;

/** Decode one descriptor at `cursor`, or throw where it is malformed. */
const readDescriptor = (
  table: Buffer,
  cursor: number,
  fileOffset: number,
  descriptorCount: number,
): {
  readonly descriptor: AndroidVbmetaDescriptor;
  readonly reservedNonZero: boolean;
  readonly next: number;
} => {
  if (table.length - cursor < 16)
    malformed(
      "descriptor header does not fit in the descriptors block",
      "descriptor",
      fileOffset + cursor,
    );
  if (descriptorCount >= AVB_MAX_DESCRIPTORS)
    capacity(
      `descriptor count exceeds the fixed ${String(AVB_MAX_DESCRIPTORS)}-descriptor ceiling`,
      DESCRIPTOR_COUNT_LIMIT,
      "descriptors",
      fileOffset + cursor,
    );
  const tag = u64(table, cursor);
  const following = u64Safe(table, cursor + 8, "descriptor size", fileOffset);
  if (following % AVB_DESCRIPTOR_ALIGNMENT !== 0)
    malformed(
      `descriptor size ${String(following)} is not a multiple of 8`,
      "num_bytes_following",
      fileOffset + cursor + 8,
    );
  if (following > table.length - cursor - 16)
    malformed(
      "descriptor extends past the descriptors block",
      "descriptor",
      fileOffset + cursor + 8,
    );
  const body = table.subarray(cursor + 16, cursor + 16 + following);
  return {
    ...parseDescriptor(tag, body, fileOffset + cursor),
    next: cursor + 16 + following,
  };
};

/**
 * Walk the descriptor table. A malformed descriptor stops the walk; the
 * descriptors before it are kept and the failure is reported, so the header
 * and the decoded prefix survive. A fixed ceiling still refuses the image.
 */
const walkDescriptors = (
  table: Buffer,
  fileOffset: number,
): {
  readonly descriptors: AndroidVbmetaDescriptor[];
  readonly limitations: string[];
  readonly failure: AndroidVbmetaDescriptorFailure | null;
} => {
  const descriptors: AndroidVbmetaDescriptor[] = [];
  const limitations: string[] = [];
  const unknownTags = new Set<string>();
  let unknownCount = 0;
  let cursor = 0;
  let reservedNonZero = false;
  let failure: AndroidVbmetaDescriptorFailure | null = null;
  while (cursor < table.length) {
    const read = caught(() =>
      readDescriptor(table, cursor, fileOffset, descriptors.length),
    );
    if (!read.ok) {
      const facts = read.error.failure;
      if (facts.kind !== "malformed" && facts.kind !== "truncated")
        throw read.error;
      failure = {
        kind: facts.kind,
        detail: facts.detail,
        field: facts.field ?? null,
        offset: facts.offset ?? fileOffset + cursor,
        descriptor_offset: fileOffset + cursor,
        unexamined_bytes: table.length - cursor,
      };
      break;
    }
    const parsed = read.value;
    if (parsed.descriptor.tag_name === "UNKNOWN") {
      unknownCount += 1;
      unknownTags.add(parsed.descriptor.tag);
    }
    reservedNonZero ||= parsed.reservedNonZero;
    descriptors.push(parsed.descriptor);
    cursor = parsed.next;
  }
  if (failure !== null)
    limitations.push(descriptorFailureLimitation(failure, descriptors.length));
  if (unknownCount > 0)
    limitations.push(unknownTagsLimitation(unknownCount, unknownTags));
  if (reservedNonZero)
    limitations.push("A descriptor reserved field contains non-zero bytes.");
  return { descriptors, limitations, failure };
};

/** Decode one vbmeta image. `bytes` must cover the declared header and blocks. */
export const parseAndroidVbmeta = (
  bytes: Buffer,
  fileSize: number,
): Result<AndroidVbmetaImage, AndroidVbmetaParseError> =>
  caught(() => {
    const extent = androidVbmetaImageExtent(bytes, fileSize);
    if (!extent.ok) throw extent.error;
    const header = extent.value;
    if (bytes.length < header.imageSize)
      truncated(
        `image is truncated: vbmeta ends at byte ${String(header.imageSize)} but ${String(bytes.length)} bytes were read`,
        "image",
        bytes.length,
      );
    const auxiliaryOffset = AVB_HEADER_SIZE + header.authenticationSize;
    const table = bytes.subarray(
      auxiliaryOffset + header.descriptorsOffset,
      auxiliaryOffset + header.descriptorsOffset + header.descriptorsSize,
    );
    const walked = walkDescriptors(
      table,
      auxiliaryOffset + header.descriptorsOffset,
    );
    const publicKey =
      header.publicKeySize === 0
        ? null
        : bytes.subarray(
            auxiliaryOffset + header.publicKeyOffset,
            auxiliaryOffset + header.publicKeyOffset + header.publicKeySize,
          );
    const algorithmName =
      ALGORITHM_NAMES[header.algorithmType] ?? ("UNKNOWN" as const);
    const limitations = [
      ANDROID_VBMETA_LIMITATIONS.unverified,
      ANDROID_VBMETA_LIMITATIONS.untrusted,
      ...walked.limitations,
    ];
    const layoutSupported = header.major === AVB_SUPPORTED_MAJOR;
    if (!layoutSupported)
      limitations.push(
        `Required libavb version ${String(header.major)}.${String(header.minor)} is not a supported major version. Its header, descriptors, and child ranges were decoded with the version-1 layout as an assumption and are unconfirmed.`,
      );
    if (algorithmName === "UNKNOWN")
      limitations.push(
        `Algorithm type ${String(header.algorithmType)} is not a known AVB algorithm; the raw value is retained.`,
      );
    if (header.reservedNonZero)
      limitations.push("The header reserved field contains non-zero bytes.");
    const children: AndroidVbmetaChild[] = [];
    if (header.authenticationSize > 0)
      children.push({
        path: "authentication_block",
        role: "authentication-block",
        offset: AVB_HEADER_SIZE,
        size: header.authenticationSize,
      });
    if (header.publicKeySize > 0)
      children.push({
        path: "public_key",
        role: "public-key",
        offset: auxiliaryOffset + header.publicKeyOffset,
        size: header.publicKeySize,
      });
    if (header.publicKeyMetadataSize > 0)
      children.push({
        path: "public_key_metadata",
        role: "public-key-metadata",
        offset: auxiliaryOffset + header.publicKeyMetadataOffset,
        size: header.publicKeyMetadataSize,
      });
    return {
      imageSize: header.imageSize,
      layoutSupported,
      children,
      limitations,
      metadata: {
        magic: AVB_MAGIC,
        required_libavb_version_major: header.major,
        required_libavb_version_minor: header.minor,
        algorithm_type: header.algorithmType,
        algorithm_name: algorithmName,
        authentication_data_block_size: header.authenticationSize,
        auxiliary_data_block_size: header.auxiliarySize,
        hash_offset: header.hashOffset,
        hash_size: header.hashSize,
        signature_offset: header.signatureOffset,
        signature_size: header.signatureSize,
        public_key_offset: header.publicKeyOffset,
        public_key_size: header.publicKeySize,
        public_key_sha256: publicKey === null ? null : sha256Hex(publicKey),
        public_key_metadata_offset: header.publicKeyMetadataOffset,
        public_key_metadata_size: header.publicKeyMetadataSize,
        descriptors_offset: header.descriptorsOffset,
        descriptors_size: header.descriptorsSize,
        rollback_index: header.rollbackIndex,
        rollback_index_location: header.rollbackIndexLocation,
        flags: header.flags,
        flag_names: flagNames(header.flags, HEADER_FLAGS),
        release_string: header.release.text,
        release_string_bytes_hex: header.release.hex,
        image_size: header.imageSize,
        trailing_bytes: fileSize - header.imageSize,
        signatures_verified: false,
        descriptors: walked.descriptors,
        descriptor_failure: walked.failure,
      },
    };
  });
