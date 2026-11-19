import { Buffer } from "node:buffer";

/** LZMA custom GUIDed-section definition GUID (display form). */
export const GUID_LZMA_CUSTOM_DISPLAY = "ee4e5898-3914-4259-9d6e-dc7bd79403cf";

/** GUID display string to the 16 raw little-endian bytes images carry. */
export function guidBytes(display: string): Buffer {
  const parts = display.split("-");
  const bytes = Buffer.alloc(16, 0);
  bytes.writeUInt32LE(Number.parseInt(parts[0] ?? "0", 16), 0);
  bytes.writeUInt16LE(Number.parseInt(parts[1] ?? "0", 16), 4);
  bytes.writeUInt16LE(Number.parseInt(parts[2] ?? "0", 16), 6);
  Buffer.from(parts.slice(3).join(""), "hex").copy(bytes, 8);
  return bytes;
}

const payloadSum = (buffer: Buffer): number => {
  let total = 0;
  for (const byte of buffer) {
    total = (total + byte) & 0xff;
  }
  return total;
};

export interface FfsFileSpec {
  guid: string;
  typeCode: number;
  /** File data; pad files normally have an empty payload. */
  payload: Buffer;
  alignmentExponent?: number;
  /** File-integrity mode; "correct"/"wrong" set the 0x40 attribute bit. */
  fileChecksum?: "none" | "correct" | "wrong";
  erasePolarity?: boolean;
  /** Deliberately corrupt the header checksum byte. */
  breakHeaderChecksum?: boolean;
}

const NORMALIZED_COMPLETE_STATE = 0x07;

/** Build one 24-byte FFS file with correct header checksum and state bits. */
export function buildFfsFile(spec: FfsFileSpec): Buffer {
  const erasePolarity = spec.erasePolarity ?? true;
  const header = Buffer.alloc(24, 0);
  guidBytes(spec.guid).copy(header, 0);
  const size = 24 + spec.payload.length;
  if (size > 0xffffff) {
    throw new Error("test FFS files must stay below the extended-size marker");
  }
  header[20] = size & 0xff;
  header[21] = (size >> 8) & 0xff;
  header[22] = (size >> 16) & 0xff;
  header[18] = spec.typeCode;
  const fileChecksumWanted =
    spec.fileChecksum === "correct" || spec.fileChecksum === "wrong";
  header[19] =
    ((spec.alignmentExponent ?? 0) << 3) | (fileChecksumWanted ? 0x40 : 0);
  header[23] = erasePolarity
    ? ~NORMALIZED_COMPLETE_STATE & 0x3f
    : NORMALIZED_COMPLETE_STATE;
  let sum = 0;
  for (let offset = 0; offset < 24; offset += 1) {
    const skip = offset === 23 || offset === 17 || offset === 16;
    sum = (sum + (skip ? 0 : (header[offset] ?? 0))) & 0xff;
  }
  header[16] = (0x100 - sum) & 0xff;
  if (spec.fileChecksum === "correct") {
    header[17] = (0x100 - payloadSum(spec.payload)) & 0xff;
  } else if (spec.fileChecksum === "wrong") {
    header[17] = (0x100 - payloadSum(spec.payload) + 1) & 0xff;
  } else {
    header[17] = 0xaa;
  }
  if (spec.breakHeaderChecksum === true) {
    header[16] = ((header[16] ?? 0) + 1) & 0xff;
  }
  return Buffer.concat([header, spec.payload]);
}

export interface FvSpec {
  files: readonly Buffer[];
  blockSize?: number;
  blockMapEntries?: number;
  erase?: 0xff | 0x00;
  fileSystemGuid?: string;
  extendedHeader?: "standalone" | "pad-file";
}

export interface BuiltFv {
  buffer: Buffer;
  absoluteBase: number;
  declaredLength: number;
  headerLength: number;
  files: readonly Buffer[];
}

const aligned = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

/** FV header: 56 fixed bytes + one block pair + the {0,0} terminator. */
const FV_HEADER_TEST_LENGTH = 72;

/**
 * Build a complete firmware volume: terminated block map (FFS2, 16-bit-word
 * checksum), 8-aligned files, erase padding to the block boundary.
 */
export function buildFv(spec: FvSpec, absoluteBase = 0): BuiltFv {
  const blockSize = spec.blockSize ?? 0x1000;
  const erase = spec.erase ?? (0xff as const);
  const blockMapEntries = spec.blockMapEntries ?? 1;
  const headerLength = FV_HEADER_TEST_LENGTH + 8 * (blockMapEntries - 1);
  const fileSystemGuid =
    spec.fileSystemGuid ?? "8c8ce578-8a3d-4f1c-9935-896185c32dd3";
  const extension = spec.extendedHeader === undefined ? null : Buffer.alloc(28);
  if (extension !== null) {
    guidBytes("12345678-1234-4321-aaaa-bbbbbbbbbbbb").copy(extension);
    extension.writeUInt32LE(extension.length, 16);
    extension.writeUInt16LE(8, 20);
    extension.writeUInt16LE(3, 22); // EFI_FV_EXT_TYPE_USED_SIZE
    extension.writeUInt32LE(blockSize, 24);
  }
  const extendedPrefix =
    extension === null
      ? []
      : [
          spec.extendedHeader === "pad-file"
            ? buildFfsFile({
                guid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
                typeCode: 0xf0,
                payload: extension,
                erasePolarity: erase === 0xff,
              })
            : extension,
        ];
  const fileArea = Buffer.concat(
    [...extendedPrefix, ...spec.files].map((file) => {
      const padTo = aligned(file.length, 8);
      return Buffer.concat([file, Buffer.alloc(padTo - file.length, erase)]);
    }),
  );
  const declaredLength = Math.max(
    blockSize,
    aligned(headerLength + fileArea.length, blockSize),
  );
  const header = Buffer.alloc(headerLength, 0);
  guidBytes(fileSystemGuid).copy(header, 16);
  header.writeBigUInt64LE(BigInt(declaredLength), 32);
  header.write("_FVH", 40, "ascii");
  header.writeUInt32LE(erase === 0xff ? 0x800 : 0, 44);
  header.writeUInt16LE(headerLength, 48);
  if (extension !== null)
    header.writeUInt16LE(
      headerLength + (spec.extendedHeader === "pad-file" ? 24 : 0),
      52,
    );
  header[54] = 0;
  header[55] = 2; // EFI_FIRMWARE_VOLUME_HEADER.Revision
  const mappedBlocks = Math.max(1, Math.ceil(declaredLength / blockSize));
  if (blockMapEntries === 1) {
    header.writeUInt32LE(mappedBlocks, 56);
    header.writeUInt32LE(blockSize, 60);
  } else {
    // Distinct contiguous blocks whose total covers the declared volume.
    for (let entry = 0; entry < blockMapEntries; entry += 1) {
      header.writeUInt32LE(1, 56 + 8 * entry);
      header.writeUInt32LE(
        entry === 0 ? declaredLength - blockMapEntries + 1 : 1,
        60 + 8 * entry,
      );
    }
  }
  // The following block-map terminator pair stays zero.
  let wordSum = 0;
  for (let offset = 0; offset < headerLength; offset += 2) {
    if (offset === 50) {
      continue;
    }
    wordSum = (wordSum + header.readUInt16LE(offset)) & 0xffff;
  }
  header.writeUInt16LE((0x10000 - wordSum) & 0xffff, 50);
  const buffer = Buffer.concat([
    header,
    fileArea,
    Buffer.alloc(declaredLength - headerLength - fileArea.length, erase),
  ]);
  return {
    buffer,
    absoluteBase,
    declaredLength,
    headerLength,
    files: spec.files,
  };
}

/** Plain (non-guided) section: 4-byte header + body, 4-byte aligned in a chain. */
export function buildSection(typeCode: number, body: Buffer): Buffer {
  const size = 4 + body.length;
  const section = Buffer.concat([
    Buffer.from([
      size & 0xff,
      (size >> 8) & 0xff,
      (size >> 16) & 0xff,
      typeCode,
    ]),
    body,
    Buffer.alloc(aligned(size, 4) - size, 0),
  ]);
  return section;
}

export interface GuidedSectionSpec {
  definitionGuid: string;
  body: Buffer;
  dataOffset?: number;
  attributes?: number;
}

/** GUIDed section: 24-byte header (definition GUID, DataOffset, Attributes) + payload. */
export function buildGuidedSection(spec: GuidedSectionSpec): Buffer {
  const dataOffset = spec.dataOffset ?? 24;
  const size = dataOffset + spec.body.length;
  const section = Buffer.alloc(size, 0);
  section[0] = size & 0xff;
  section[1] = (size >> 8) & 0xff;
  section[2] = (size >> 16) & 0xff;
  section[3] = 0x02;
  guidBytes(spec.definitionGuid).copy(section, 4);
  section.writeUInt16LE(dataOffset, 20);
  section.writeUInt16LE(spec.attributes ?? 0, 22);
  spec.body.copy(section, dataOffset);
  return section.subarray(0, aligned(size, 4));
}

/** LZMA-custom guided section body: the raw `.lzma` stream bytes. */
export function buildLzmaGuidedSection(compressed: Buffer): Buffer {
  return buildGuidedSection({
    definitionGuid: GUID_LZMA_CUSTOM_DISPLAY,
    body: compressed,
  });
}

/** Classic compression section: UncompressedLength u32 + CompressionType u8. */
export function buildCompressionSection(
  compressed: Buffer,
  compressionType: number,
  uncompressedLength: number,
): Buffer {
  const body = Buffer.alloc(5, 0);
  body.writeUInt32LE(uncompressedLength, 0);
  body[4] = compressionType;
  return buildSection(0x01, Buffer.concat([body, compressed]));
}

export interface ImageSpec {
  volumes: readonly Buffer[];
  /** Optional filler after concatenation, in bytes. */
  tailPad?: number;
  erase?: 0xff | 0x00;
  alignment?: number;
}

/** Concatenate volumes with erase padding between them into one image. */
export function buildImage(spec: ImageSpec): Buffer {
  const align = spec.alignment ?? 0x1000;
  const erase = spec.erase ?? (0xff as const);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const volume of spec.volumes) {
    const pad = aligned(cursor, align) - cursor;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad, erase));
      cursor += pad;
    }
    chunks.push(volume);
    cursor += volume.length;
  }
  if ((spec.tailPad ?? 0) > 0) {
    chunks.push(Buffer.alloc(spec.tailPad ?? 0, erase));
    cursor += spec.tailPad ?? 0;
  }
  return Buffer.concat(chunks);
}
