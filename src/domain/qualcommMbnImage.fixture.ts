/** Synthetic Qualcomm MBN images; no vendor bytes. */

export interface MbnHeaderFixture {
  readonly version?: 3 | 5 | 6;
  readonly imageId?: number;
  /** Flash source offset (v3 `image_src`). */
  readonly imageSource?: number;
  /** Header-relative virtual address of the code region. */
  readonly destination?: number;
  readonly code: Buffer;
  readonly signature: Buffer;
  readonly certificateChain: Buffer;
  readonly qtiSignature?: Buffer;
  readonly qtiCertificateChain?: Buffer;
  readonly metadata0?: Buffer;
  readonly metadata1?: Buffer;
}

/** A legacy header followed by its regions; pointers are virtual addresses. */
export const mbnLegacyImage = ({
  version = 3,
  imageId = 21,
  imageSource = 0,
  destination = 0x8600_0028,
  code,
  signature,
  certificateChain,
  qtiSignature = Buffer.alloc(0),
  qtiCertificateChain = Buffer.alloc(0),
  metadata0 = Buffer.alloc(0),
  metadata1 = Buffer.alloc(0),
}: MbnHeaderFixture): Buffer => {
  const headerBytes = { 3: 40, 5: 40, 6: 48 }[version];
  const header = Buffer.alloc(headerBytes);
  const signaturePointer = destination + code.length;
  const certificatePointer = signaturePointer + signature.length;
  const payload =
    code.length +
    signature.length +
    certificateChain.length +
    qtiSignature.length +
    qtiCertificateChain.length +
    metadata0.length +
    metadata1.length;
  header.writeUInt32LE(imageId, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(version === 3 ? imageSource : qtiSignature.length, 8);
  header.writeUInt32LE(
    version === 3 ? destination : qtiCertificateChain.length,
    12,
  );
  header.writeUInt32LE(payload, 16);
  header.writeUInt32LE(code.length, 20);
  header.writeUInt32LE(
    version === 3
      ? signature.length === 0
        ? 0
        : signaturePointer
      : 0xffff_ffff,
    24,
  );
  header.writeUInt32LE(signature.length, 28);
  header.writeUInt32LE(
    version === 3
      ? certificateChain.length === 0
        ? 0
        : certificatePointer
      : 0xffff_ffff,
    32,
  );
  header.writeUInt32LE(certificateChain.length, 36);
  if (version === 6) {
    header.writeUInt32LE(metadata0.length, 40);
    header.writeUInt32LE(metadata1.length, 44);
  }
  return Buffer.concat([
    header,
    metadata0,
    metadata1,
    code,
    qtiSignature,
    qtiCertificateChain,
    signature,
    certificateChain,
  ]);
};

export interface MbnElfSegment {
  readonly type: number;
  readonly flags: number;
  readonly data: Buffer;
}

const HASH_SEGMENT_FLAGS = 0x0220_0000;
const ELF_HEADER_SEGMENT_FLAGS = 0x0700_0000;

/**
 * An ELF32 little-endian image. Each segment's data is placed in order after
 * the program header table, 16-byte aligned.
 */
export const mbnElfImage = (segments: readonly MbnElfSegment[]): Buffer => {
  const phoff = 52;
  const tableEnd = phoff + segments.length * 32;
  const offsets: number[] = [];
  let cursor = Math.ceil(tableEnd / 16) * 16;
  for (const segment of segments) {
    offsets.push(segment.data.length === 0 ? 0 : cursor);
    cursor = Math.ceil((cursor + segment.data.length) / 16) * 16;
  }
  const image = Buffer.alloc(cursor);
  image.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  image.writeUInt16LE(2, 16); // ET_EXEC
  image.writeUInt16LE(164, 18); // EM_QDSP6
  image.writeUInt32LE(1, 20);
  image.writeUInt32LE(phoff, 28);
  image.writeUInt16LE(52, 40);
  image.writeUInt16LE(32, 42);
  image.writeUInt16LE(segments.length, 44);
  image.writeUInt16LE(40, 46);
  segments.forEach((segment, index) => {
    const row = phoff + index * 32;
    image.writeUInt32LE(segment.type, row);
    image.writeUInt32LE(offsets[index]!, row + 4);
    image.writeUInt32LE(0x8000_0000 + index * 0x10_0000, row + 8);
    image.writeUInt32LE(0x8000_0000 + index * 0x10_0000, row + 12);
    image.writeUInt32LE(segment.data.length, row + 16);
    image.writeUInt32LE(segment.data.length, row + 20);
    image.writeUInt32LE(segment.flags, row + 24);
    image.writeUInt32LE(0x1000, row + 28);
    image.set(segment.data, offsets[index]!);
  });
  return image;
};

/**
 * A modem-style ELF MBN: an ELF-header NULL segment, the hash segment, and
 * `loads` PT_LOAD segments. The hash table holds one SHA-256-sized slot per
 * program header.
 */
export const mbnElfWithHashSegment = ({
  loads = 1,
  signature = Buffer.alloc(256, 0x5a),
  certificateChain = Buffer.alloc(96, 0xc3),
  version = 3,
}: {
  readonly loads?: number;
  readonly signature?: Buffer;
  readonly certificateChain?: Buffer;
  readonly version?: 3 | 5 | 6;
} = {}): Buffer => {
  const programs = loads + 2;
  const hashSegment = mbnLegacyImage({
    version,
    imageId: 0,
    destination: 0x8810_0028,
    code: Buffer.alloc(programs * 32, 0x11),
    signature,
    certificateChain,
  });
  return mbnElfImage([
    { type: 0, flags: ELF_HEADER_SEGMENT_FLAGS, data: Buffer.alloc(0) },
    { type: 0, flags: HASH_SEGMENT_FLAGS, data: hashSegment },
    ...Array.from({ length: loads }, (_, index) => ({
      type: 1,
      flags: 5,
      data: Buffer.alloc(64, index + 1),
    })),
  ]);
};
