/**
 * Synthetic standalone vbmeta (`AVB0`) images.
 * Field offsets follow AOSP `libavb` (`avb_vbmeta_image.h`, `avb_descriptor.h`
 * and the per-descriptor headers): all multi-byte fields are big-endian,
 * the header is 256 bytes, authentication and auxiliary blocks are
 * multiples of 64 bytes, and each descriptor's `num_bytes_following` is a
 * multiple of 8.
 */

const HEADER_SIZE = 256;
const DESCRIPTOR_HEADER_SIZE = 16;
const BLOCK_ALIGNMENT = 64;

const alignUp = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

const u32be = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
};

const u64be = (value: number | bigint): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value), 0);
  return out;
};

const nulTerminated = (text: string): Buffer =>
  Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);

const paddedBody = (body: Buffer): Buffer => {
  const padded = alignUp(body.length, 8);
  return padded === body.length
    ? body
    : Buffer.concat([body, Buffer.alloc(padded - body.length)]);
};

export interface AvbDescriptorFixture {
  readonly tag: number;
  /** Bytes following the 16-byte descriptor header; padded to a multiple of 8. */
  readonly body: Buffer;
}

/** One descriptor: 16-byte header plus its padded body. */
export const encodeDescriptor = (fixture: AvbDescriptorFixture): Buffer =>
  Buffer.concat([
    u64be(fixture.tag),
    u64be(paddedBody(fixture.body).length),
    paddedBody(fixture.body),
  ]);

/** Property descriptor (tag 0): NUL-terminated key and value. */
export const propertyDescriptor = (
  key: string,
  value: string,
): AvbDescriptorFixture => {
  const keyBytes = nulTerminated(key);
  const valueBytes = nulTerminated(value);
  return {
    tag: 0,
    body: Buffer.concat([
      u64be(keyBytes.length),
      u64be(valueBytes.length),
      keyBytes,
      valueBytes,
    ]),
  };
};

/** Hashtree descriptor (tag 1) for a dm-verity partition. */
export const hashtreeDescriptor = (input: {
  readonly dmVerityVersion?: number;
  readonly imageSize?: number;
  readonly treeOffset?: number;
  readonly treeSize?: number;
  readonly dataBlockSize?: number;
  readonly hashBlockSize?: number;
  readonly fecNumRoots?: number;
  readonly fecOffset?: number;
  readonly fecSize?: number;
  readonly hashAlgorithm?: string;
  readonly partitionName?: string;
  readonly salt?: Buffer;
  readonly rootDigest?: Buffer;
  readonly flags?: number;
}): AvbDescriptorFixture => {
  const partitionName = nulTerminated(input.partitionName ?? "system");
  const salt = input.salt ?? Buffer.from("salt");
  const rootDigest = input.rootDigest ?? Buffer.alloc(32, 0xab);
  const hashAlgorithm = Buffer.alloc(32);
  hashAlgorithm.write(input.hashAlgorithm ?? "sha256", 0, "utf8");
  return {
    tag: 1,
    body: Buffer.concat([
      u32be(input.dmVerityVersion ?? 1),
      u64be(input.imageSize ?? 4096),
      u64be(input.treeOffset ?? 4096),
      u64be(input.treeSize ?? 4096),
      u32be(input.dataBlockSize ?? 4096),
      u32be(input.hashBlockSize ?? 4096),
      u32be(input.fecNumRoots ?? 0),
      u64be(input.fecOffset ?? 0),
      u64be(input.fecSize ?? 0),
      hashAlgorithm,
      u32be(partitionName.length),
      u32be(salt.length),
      u32be(rootDigest.length),
      u32be(input.flags ?? 0),
      Buffer.alloc(60),
      partitionName,
      salt,
      rootDigest,
    ]),
  };
};

/** Hash descriptor (tag 2) for a directly hashed partition. */
export const hashDescriptor = (input: {
  readonly imageSize?: number;
  readonly hashAlgorithm?: string;
  readonly partitionName?: string;
  readonly salt?: Buffer;
  readonly digest?: Buffer;
  readonly flags?: number;
}): AvbDescriptorFixture => {
  const partitionName = nulTerminated(input.partitionName ?? "boot");
  const salt = input.salt ?? Buffer.from("salt");
  const digest = input.digest ?? Buffer.alloc(32, 0xcd);
  const hashAlgorithm = Buffer.alloc(32);
  hashAlgorithm.write(input.hashAlgorithm ?? "sha256", 0, "utf8");
  return {
    tag: 2,
    body: Buffer.concat([
      u64be(input.imageSize ?? 2048),
      hashAlgorithm,
      u32be(partitionName.length),
      u32be(salt.length),
      u32be(digest.length),
      u32be(input.flags ?? 0),
      Buffer.alloc(60),
      partitionName,
      salt,
      digest,
    ]),
  };
};

/** Kernel cmdline descriptor (tag 3). */
export const kernelCmdlineDescriptor = (
  cmdline: string,
  flags = 0,
): AvbDescriptorFixture => {
  const bytes = nulTerminated(cmdline);
  return {
    tag: 3,
    body: Buffer.concat([u32be(flags), u32be(bytes.length), bytes]),
  };
};

/** Chain partition descriptor (tag 4). */
export const chainPartitionDescriptor = (input: {
  readonly rollbackIndexLocation?: number;
  readonly partitionName?: string;
  readonly publicKey?: Buffer;
  readonly flags?: number;
}): AvbDescriptorFixture => {
  const partitionName = nulTerminated(input.partitionName ?? "vbmeta_system");
  const publicKey = input.publicKey ?? Buffer.alloc(64, 0x11);
  return {
    tag: 4,
    body: Buffer.concat([
      u32be(input.rollbackIndexLocation ?? 0),
      u32be(partitionName.length),
      u32be(publicKey.length),
      u32be(input.flags ?? 0),
      Buffer.alloc(60),
      partitionName,
      publicKey,
    ]),
  };
};

export interface AvbVbmetaImageOptions {
  readonly versionMajor?: number;
  readonly versionMinor?: number;
  readonly algorithmType?: number;
  /** Hash bytes inside the authentication block. */
  readonly hash?: Buffer;
  /** Signature bytes inside the authentication block, after the hash. */
  readonly signature?: Buffer;
  /** Public key bytes at the start of the auxiliary block. */
  readonly publicKey?: Buffer;
  /** Public key metadata bytes after the public key. */
  readonly publicKeyMetadata?: Buffer;
  readonly descriptors?: readonly AvbDescriptorFixture[];
  readonly rollbackIndex?: number | bigint;
  readonly flags?: number;
  readonly rollbackIndexLocation?: number;
  readonly releaseString?: string;
}

/**
 * Build a standalone vbmeta image: 256-byte header, an authentication
 * block holding `hash` and `signature`, and an auxiliary block holding the
 * public key, its metadata, and the descriptor table.
 */
export const buildVbmetaImage = (
  options: AvbVbmetaImageOptions = {},
): Buffer => {
  const hash = options.hash ?? Buffer.alloc(0);
  const signature = options.signature ?? Buffer.alloc(0);
  const authSize = alignUp(hash.length + signature.length, BLOCK_ALIGNMENT);
  const publicKey = options.publicKey ?? Buffer.alloc(0);
  const publicKeyMetadata = options.publicKeyMetadata ?? Buffer.alloc(0);
  const descriptors = Buffer.concat(
    (options.descriptors ?? []).map(encodeDescriptor),
  );
  const descriptorsOffset = alignUp(
    publicKey.length + publicKeyMetadata.length,
    8,
  );
  const auxSize = alignUp(
    descriptorsOffset + descriptors.length,
    BLOCK_ALIGNMENT,
  );
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("AVB0", 0, "ascii");
  header.writeUInt32BE(options.versionMajor ?? 1, 4);
  header.writeUInt32BE(options.versionMinor ?? 0, 8);
  header.writeBigUInt64BE(BigInt(authSize), 12);
  header.writeBigUInt64BE(BigInt(auxSize), 20);
  header.writeUInt32BE(options.algorithmType ?? 1, 28);
  header.writeBigUInt64BE(0n, 32);
  header.writeBigUInt64BE(BigInt(hash.length), 40);
  header.writeBigUInt64BE(BigInt(hash.length), 48);
  header.writeBigUInt64BE(BigInt(signature.length), 56);
  header.writeBigUInt64BE(0n, 64);
  header.writeBigUInt64BE(BigInt(publicKey.length), 72);
  header.writeBigUInt64BE(BigInt(publicKey.length), 80);
  header.writeBigUInt64BE(BigInt(publicKeyMetadata.length), 88);
  header.writeBigUInt64BE(BigInt(descriptorsOffset), 96);
  header.writeBigUInt64BE(BigInt(descriptors.length), 104);
  header.writeBigUInt64BE(BigInt(options.rollbackIndex ?? 0), 112);
  header.writeUInt32BE(options.flags ?? 0, 120);
  header.writeUInt32BE(options.rollbackIndexLocation ?? 0, 124);
  header.write(options.releaseString ?? "avbtool 1.2.0", 128, "utf8");
  const auth = Buffer.alloc(authSize);
  hash.copy(auth, 0);
  signature.copy(auth, hash.length);
  const aux = Buffer.alloc(auxSize);
  publicKey.copy(aux, 0);
  publicKeyMetadata.copy(aux, publicKey.length);
  descriptors.copy(aux, descriptorsOffset);
  return Buffer.concat([header, auth, aux]);
};

/** A vbmeta image with one descriptor of each well-known tag (0-4). */
export const buildVbmetaImageWithAllDescriptors = (): Buffer =>
  buildVbmetaImage({
    versionMinor: 2,
    algorithmType: 1,
    hash: Buffer.alloc(32, 0xaa),
    signature: Buffer.alloc(256, 0xbb),
    publicKey: Buffer.alloc(64, 0xcc),
    descriptors: [
      propertyDescriptor("com.android.build.fingerprint", "test-fingerprint"),
      hashtreeDescriptor({}),
      hashDescriptor({}),
      kernelCmdlineDescriptor("androidboot.veritymode=enforcing"),
      chainPartitionDescriptor({}),
    ],
    rollbackIndex: 7,
    flags: 0,
    rollbackIndexLocation: 2,
    releaseString: "avbtool 1.2.0",
  });
