import {
  AVB_ALGORITHM,
  AVB_DESCRIPTOR_TAG,
  AVB_HASHTREE_FLAG,
  AVB_HEADER_FLAG,
  AVB_KERNEL_CMDLINE_FLAG,
} from "./androidVbmeta.js";
import { DEFAULT_ANDROID_VBMETA_READER_LIMITS } from "../artifactReaderLimits.js";

const DEFAULTS = DEFAULT_ANDROID_VBMETA_READER_LIMITS;

/** Public key bytes shared by the image and its chain-partition descriptor. */
export const SAMPLE_PUBLIC_KEY = Buffer.from("vbmeta-test-public-key");
export const SAMPLE_PUBLIC_KEY_METADATA = Buffer.from("pkmd-bytes");
export const SAMPLE_RELEASE = "avbtool 1.2.0";
export const SAMPLE_PROPERTY_KEY = "com.android.build.boot.os_version";
export const SAMPLE_PROPERTY_VALUE = "13";
export const SAMPLE_HASHTREE_PARTITION = "system";
export const SAMPLE_HASHTREE_SALT = Buffer.from("salt-bytes");
export const SAMPLE_HASHTREE_DIGEST = Buffer.from("root-digest-bytes");
export const SAMPLE_HASH_PARTITION = "boot";
export const SAMPLE_HASH_SALT = Buffer.from([0x01, 0x02, 0x03, 0x04]);
export const SAMPLE_HASH_DIGEST = Buffer.alloc(32, 0xab);
export const SAMPLE_CMDLINE = "androidboot.slot_suffix=_a";
export const SAMPLE_CHAIN_PARTITION = "vbmeta_system";
export const SAMPLE_UNKNOWN_TAG = 7;

const HEADER_SIZE = 256;
const RELEASE_STRING_SIZE = 48;
const BLOCK_ALIGNMENT = 64;

const writeU64 = (
  bytes: Buffer,
  offset: number,
  value: number | bigint,
): void => {
  bytes.writeBigUInt64BE(BigInt(value), offset);
};

const aligned = (bytes: Buffer, alignment: number): Buffer => {
  const remainder = bytes.length % alignment;
  return remainder === 0
    ? bytes
    : Buffer.concat([bytes, Buffer.alloc(alignment - remainder)]);
};

const fixedText = (text: string, size: number): Buffer => {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length >= size)
    throw new Error(`${text} does not fit in ${String(size)} bytes`);
  const out = Buffer.alloc(size);
  encoded.copy(out);
  return out;
};

/** One descriptor: tag, 8-byte-aligned body, and the 16-byte header. */
export const androidVbmetaDescriptor = (
  tag: number | bigint,
  body: Buffer,
): Buffer => {
  const padded = aligned(body, 8);
  const header = Buffer.alloc(16);
  writeU64(header, 0, tag);
  writeU64(header, 8, padded.length);
  return Buffer.concat([header, padded]);
};

const propertyBody = (key: string, value: Buffer): Buffer => {
  const keyBytes = Buffer.from(key, "utf8");
  const lengths = Buffer.alloc(16);
  writeU64(lengths, 0, keyBytes.length);
  writeU64(lengths, 8, value.length);
  return Buffer.concat([
    lengths,
    keyBytes,
    Buffer.from([0]),
    value,
    Buffer.from([0]),
  ]);
};

const hashtreeBody = (): Buffer => {
  const name = Buffer.from(SAMPLE_HASHTREE_PARTITION);
  const fixed = Buffer.alloc(164);
  fixed.writeUInt32BE(1, 0);
  writeU64(fixed, 4, 409_600);
  writeU64(fixed, 12, 409_600);
  writeU64(fixed, 20, 4_096);
  fixed.writeUInt32BE(4_096, 28);
  fixed.writeUInt32BE(4_096, 32);
  fixed.writeUInt32BE(2, 36);
  writeU64(fixed, 40, 413_696);
  writeU64(fixed, 48, 4_096);
  fixedText("sha256", 32).copy(fixed, 56);
  fixed.writeUInt32BE(name.length, 88);
  fixed.writeUInt32BE(SAMPLE_HASHTREE_SALT.length, 92);
  fixed.writeUInt32BE(SAMPLE_HASHTREE_DIGEST.length, 96);
  fixed.writeUInt32BE(AVB_HASHTREE_FLAG.DO_NOT_USE_AB, 100);
  return Buffer.concat([
    fixed,
    name,
    SAMPLE_HASHTREE_SALT,
    SAMPLE_HASHTREE_DIGEST,
  ]);
};

const hashBody = (): Buffer => {
  const name = Buffer.from(SAMPLE_HASH_PARTITION);
  const fixed = Buffer.alloc(116);
  writeU64(fixed, 0, 32_768);
  fixedText("sha256", 32).copy(fixed, 8);
  fixed.writeUInt32BE(name.length, 40);
  fixed.writeUInt32BE(SAMPLE_HASH_SALT.length, 44);
  fixed.writeUInt32BE(SAMPLE_HASH_DIGEST.length, 48);
  return Buffer.concat([fixed, name, SAMPLE_HASH_SALT, SAMPLE_HASH_DIGEST]);
};

const cmdlineBody = (): Buffer => {
  const cmdline = Buffer.from(SAMPLE_CMDLINE);
  const fixed = Buffer.alloc(8);
  fixed.writeUInt32BE(
    AVB_KERNEL_CMDLINE_FLAG.USE_ONLY_IF_HASHTREE_NOT_DISABLED,
    0,
  );
  fixed.writeUInt32BE(cmdline.length, 4);
  return Buffer.concat([fixed, cmdline]);
};

const chainBody = (publicKey: Buffer = SAMPLE_PUBLIC_KEY): Buffer => {
  const name = Buffer.from(SAMPLE_CHAIN_PARTITION);
  const fixed = Buffer.alloc(76);
  fixed.writeUInt32BE(2, 0);
  fixed.writeUInt32BE(name.length, 4);
  fixed.writeUInt32BE(publicKey.length, 8);
  fixed.writeUInt32BE(1, 12);
  return Buffer.concat([fixed, name, publicKey]);
};

/** Header fields a caller can set without synthesizing the blocks. */
export interface AndroidVbmetaHeaderFields {
  readonly major?: number;
  readonly minor?: number;
  readonly algorithmType?: number;
  readonly flags?: number;
  readonly rollbackIndex?: number | bigint;
  readonly rollbackIndexLocation?: number;
  readonly release?: string | Buffer;
  readonly authenticationDataBlockSize?: number;
  readonly auxiliaryDataBlockSize?: number;
  readonly hashOffset?: number;
  readonly hashSize?: number;
  readonly signatureOffset?: number;
  readonly signatureSize?: number;
  readonly publicKeyOffset?: number;
  readonly publicKeySize?: number;
  readonly publicKeyMetadataOffset?: number;
  readonly publicKeyMetadataSize?: number;
  readonly descriptorsOffset?: number;
  readonly descriptorsSize?: number;
  readonly reserved?: Buffer;
}

/** A 256-byte header. Unset sizes are zero and the release string is empty. */
export const androidVbmetaHeader = (
  fields: AndroidVbmetaHeaderFields = {},
): Buffer => {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("AVB0", 0, "ascii");
  header.writeUInt32BE(fields.major ?? 1, 4);
  header.writeUInt32BE(fields.minor ?? 0, 8);
  writeU64(header, 12, fields.authenticationDataBlockSize ?? 0);
  writeU64(header, 20, fields.auxiliaryDataBlockSize ?? 0);
  header.writeUInt32BE(fields.algorithmType ?? AVB_ALGORITHM.NONE, 28);
  writeU64(header, 32, fields.hashOffset ?? 0);
  writeU64(header, 40, fields.hashSize ?? 0);
  writeU64(header, 48, fields.signatureOffset ?? 0);
  writeU64(header, 56, fields.signatureSize ?? 0);
  writeU64(header, 64, fields.publicKeyOffset ?? 0);
  writeU64(header, 72, fields.publicKeySize ?? 0);
  writeU64(header, 80, fields.publicKeyMetadataOffset ?? 0);
  writeU64(header, 88, fields.publicKeyMetadataSize ?? 0);
  writeU64(header, 96, fields.descriptorsOffset ?? 0);
  writeU64(header, 104, fields.descriptorsSize ?? 0);
  writeU64(header, 112, fields.rollbackIndex ?? 0);
  header.writeUInt32BE(fields.flags ?? 0, 120);
  header.writeUInt32BE(fields.rollbackIndexLocation ?? 0, 124);
  const release = fields.release ?? "";
  const releaseBytes = Buffer.isBuffer(release)
    ? release
    : Buffer.from(release, "utf8");
  if (releaseBytes.length > RELEASE_STRING_SIZE)
    throw new Error("release string exceeds 48 bytes");
  releaseBytes.copy(header, 128);
  fields.reserved?.copy(header, 176);
  return header;
};

export interface AndroidVbmetaImageParts {
  readonly hash?: Buffer;
  readonly signature?: Buffer;
  readonly publicKey?: Buffer;
  readonly publicKeyMetadata?: Buffer;
  readonly descriptorBytes?: Buffer;
  readonly trailing?: Buffer;
  readonly header?: AndroidVbmetaHeaderFields;
}

/**
 * A consistent image: authentication is hash then signature, and the auxiliary
 * block is the public key, its metadata, then the descriptor table. Empty
 * blocks stay size 0 rather than a 64-byte pad. Header fields merge over the
 * synthesized sizes, so a caller that sets a size must also supply the bytes.
 */
export const buildAndroidVbmeta = (
  parts: AndroidVbmetaImageParts = {},
): Buffer => {
  const hash = parts.hash ?? Buffer.alloc(0);
  const signature = parts.signature ?? Buffer.alloc(0);
  const publicKey = parts.publicKey ?? Buffer.alloc(0);
  const publicKeyMetadata = parts.publicKeyMetadata ?? Buffer.alloc(0);
  const descriptorBytes = parts.descriptorBytes ?? Buffer.alloc(0);
  const authentication = aligned(
    Buffer.concat([hash, signature]),
    BLOCK_ALIGNMENT,
  );
  const auxiliary = aligned(
    Buffer.concat([publicKey, publicKeyMetadata, descriptorBytes]),
    BLOCK_ALIGNMENT,
  );
  const header = androidVbmetaHeader({
    authenticationDataBlockSize: authentication.length,
    auxiliaryDataBlockSize: auxiliary.length,
    hashSize: hash.length,
    signatureOffset: hash.length,
    signatureSize: signature.length,
    publicKeySize: publicKey.length,
    publicKeyMetadataOffset: publicKey.length,
    publicKeyMetadataSize: publicKeyMetadata.length,
    descriptorsOffset: publicKey.length + publicKeyMetadata.length,
    descriptorsSize: descriptorBytes.length,
    ...parts.header,
  });
  return Buffer.concat([
    header,
    authentication,
    auxiliary,
    parts.trailing ?? Buffer.alloc(0),
  ]);
};

/** One of each descriptor, with the same public key in the header and chain. */
export const sampleAndroidVbmeta = (): Buffer => {
  const descriptors = Buffer.concat([
    androidVbmetaDescriptor(
      AVB_DESCRIPTOR_TAG.PROPERTY,
      propertyBody(SAMPLE_PROPERTY_KEY, Buffer.from(SAMPLE_PROPERTY_VALUE)),
    ),
    androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.HASHTREE, hashtreeBody()),
    androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.HASH, hashBody()),
    androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE, cmdlineBody()),
    androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.CHAIN_PARTITION, chainBody()),
    androidVbmetaDescriptor(SAMPLE_UNKNOWN_TAG, Buffer.alloc(8, 0xee)),
  ]);
  return buildAndroidVbmeta({
    hash: Buffer.alloc(32, 0x11),
    signature: Buffer.alloc(256, 0x22),
    publicKey: SAMPLE_PUBLIC_KEY,
    publicKeyMetadata: SAMPLE_PUBLIC_KEY_METADATA,
    descriptorBytes: descriptors,
    trailing: Buffer.from("tail"),
    header: {
      algorithmType: AVB_ALGORITHM.SHA256_RSA2048,
      flags:
        AVB_HEADER_FLAG.HASHTREE_DISABLED |
        AVB_HEADER_FLAG.VERIFICATION_DISABLED,
      rollbackIndex: 42,
      rollbackIndexLocation: 0,
      release: SAMPLE_RELEASE,
    },
  });
};

/**
 * A property and a hashtree descriptor, then a hash descriptor whose algorithm
 * field is not NUL-terminated, then a kernel command line the walk never reaches.
 */
export const androidVbmetaMalformedLaterDescriptor = (): Buffer => {
  const brokenHash = hashBody();
  brokenHash.fill(0xff, 8, 40);
  return buildAndroidVbmeta({
    descriptorBytes: Buffer.concat([
      androidVbmetaDescriptor(
        AVB_DESCRIPTOR_TAG.PROPERTY,
        propertyBody(SAMPLE_PROPERTY_KEY, Buffer.from(SAMPLE_PROPERTY_VALUE)),
      ),
      androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.HASHTREE, hashtreeBody()),
      androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.HASH, brokenHash),
      androidVbmetaDescriptor(AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE, cmdlineBody()),
    ]),
  });
};

/**
 * 4097 empty unknown descriptors, one past the default descriptor-count
 * admission. The whole image is 65,856 bytes.
 */
export const ANDROID_VBMETA_OVERFLOW_DESCRIPTORS =
  DEFAULTS.descriptor_count + 1;
export const androidVbmetaDescriptorCountOverflow = (): Buffer => {
  const one = androidVbmetaDescriptor(SAMPLE_UNKNOWN_TAG, Buffer.alloc(0));
  const table = Buffer.alloc(one.length * ANDROID_VBMETA_OVERFLOW_DESCRIPTORS);
  for (let index = 0; index < ANDROID_VBMETA_OVERFLOW_DESCRIPTORS; index += 1)
    one.copy(table, index * one.length);
  return buildAndroidVbmeta({ descriptorBytes: table });
};

/** Small byte-format refusals for the public artifact adapters. */
export const androidVbmetaRefusals = () =>
  [
    {
      name: "truncated-header",
      bytes: Buffer.from("AVB0"),
      kind: "truncated",
      code: "truncated",
      category: "truncated",
    },
    {
      name: "truncated-block",
      bytes: androidVbmetaHeader({ authenticationDataBlockSize: 64 }),
      kind: "truncated",
      code: "truncated",
      category: "truncated",
    },
    {
      name: "misaligned-authentication",
      bytes: androidVbmetaHeader({ authenticationDataBlockSize: 32 }),
      kind: "malformed",
      code: "invalid_request",
      category: "invalid_input",
    },
    {
      name: "hash-past-block",
      bytes: androidVbmetaHeader({ hashSize: 32 }),
      kind: "malformed",
      code: "invalid_request",
      category: "invalid_input",
    },
    {
      name: "unterminated-release",
      bytes: androidVbmetaHeader({ release: Buffer.alloc(48, 0x41) }),
      kind: "malformed",
      code: "invalid_request",
      category: "invalid_input",
    },
    {
      name: "authentication-over-cap",
      // Fully present, so only the admission budget refuses it.
      bytes: Buffer.concat([
        androidVbmetaHeader({
          authenticationDataBlockSize: DEFAULTS.authentication_block_bytes + 64,
        }),
        Buffer.alloc(DEFAULTS.authentication_block_bytes + 64),
      ]),
      kind: "limit",
      code: "truncated",
      category: "truncated",
    },
    {
      name: "descriptors-over-cap",
      bytes: Buffer.concat([
        androidVbmetaHeader({
          auxiliaryDataBlockSize: DEFAULTS.descriptor_bytes + 64,
          descriptorsSize: DEFAULTS.descriptor_bytes + 64,
        }),
        Buffer.alloc(DEFAULTS.descriptor_bytes + 64),
      ]),
      kind: "limit",
      code: "truncated",
      category: "truncated",
    },
  ] as const;
