import { crc32, deflateSync } from "node:zlib";

export interface BlockFixture {
  readonly ident: string;
  readonly sections: readonly Buffer[];
}

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/**
 * Build one synthetic RSRC container with the header, block-info list, and
 * section data this reader parses. The word at info+48 is counted from the
 * info header and ends where section names begin; those names then run to
 * the end of the info section.
 */
export const buildLabviewRsrc = (
  blocks: readonly BlockFixture[],
  names: readonly string[] = [],
): Buffer => {
  const dataParts: Buffer[] = [];
  const sectionArrays: Buffer[] = [];
  let dataLength = 0;
  for (const block of blocks) {
    const starts: Buffer[] = [];
    for (const section of block.sections) {
      const at = dataLength;
      dataParts.push(u32(section.length), section);
      dataLength += 4 + section.length;
      const pad = (4 - (dataLength % 4)) % 4;
      if (pad > 0) {
        dataParts.push(Buffer.alloc(pad));
        dataLength += pad;
      }
      const start = Buffer.alloc(20);
      start.writeInt32BE(0, 0);
      // A shared name list gives every section name offset 0; no list leaves
      // the sections unnamed.
      start.writeUInt32BE(names.length > 0 ? 0 : 0xffffffff, 4);
      start.writeUInt32BE(0, 8);
      start.writeUInt32BE(at, 12);
      start.writeUInt32BE(0, 16);
      starts.push(start);
    }
    sectionArrays.push(Buffer.concat(starts));
  }
  const data = Buffer.concat(dataParts);
  const dataOffset = 32;
  const infoOffset = dataOffset + data.length;
  const headersLength = 12 * blocks.length;
  const blockHeaders: Buffer[] = [];
  let cursor = 4 + headersLength;
  for (let index = 0; index < blocks.length; index += 1) {
    const header = Buffer.alloc(12);
    header.write(blocks[index]?.ident ?? "????", 0, 4, "latin1");
    header.writeUInt32BE((blocks[index]?.sections.length ?? 1) - 1, 4);
    header.writeUInt32BE(cursor, 8);
    blockHeaders.push(header);
    cursor += sectionArrays[index]?.length ?? 0;
  }
  const nameBytes = Buffer.concat(
    names.map((name) => {
      const bytes = Buffer.from(name, "latin1");
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }),
  );
  const blockInfo = Buffer.concat([
    u32(blocks.length - 1),
    ...blockHeaders,
    ...sectionArrays,
    nameBytes,
  ]);
  const listHeader = Buffer.alloc(20);
  listHeader.writeUInt32BE(0, 0);
  listHeader.writeUInt32BE(0, 4);
  listHeader.writeUInt32BE(32, 8);
  // Both words are offsets from the info header. The extent ends at the
  // name list, which follows the block headers and section-start tables.
  const blockInfoFromInfo = 32 + listHeader.length;
  listHeader.writeUInt32BE(blockInfoFromInfo, 12);
  listHeader.writeUInt32BE(
    blockInfoFromInfo + blockInfo.length - nameBytes.length,
    16,
  );
  const infoLength = 32 + listHeader.length + blockInfo.length;
  const header = (): Buffer => {
    const bytes = Buffer.alloc(32);
    bytes.write("RSRC\r\n", 0, 6, "latin1");
    bytes.writeUInt16BE(3, 6);
    bytes.write("LVAR", 8, 4, "latin1");
    bytes.write("LBVW", 12, 4, "latin1");
    bytes.writeUInt32BE(infoOffset, 16);
    bytes.writeUInt32BE(infoLength, 20);
    bytes.writeUInt32BE(dataOffset, 24);
    bytes.writeUInt32BE(data.length, 28);
    return bytes;
  };
  return Buffer.concat([header(), data, header(), listHeader, blockInfo]);
};

export const labviewZlibSection = (content: string | Buffer): Buffer => {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "latin1") : content;
  const encoded = deflateSync(bytes);
  return Buffer.concat([u32(bytes.length), encoded]);
};

/**
 * The packed LabVIEW `vers` record: a four-byte version word (two decimal
 * major digits, then minor, bugfix, stage and a four-digit build), a
 * two-byte language, and two empty Pascal strings.
 */
export const labviewVersionSection = (version = "11.0"): Buffer => {
  const [majorText = "0", minorText = "0"] = version.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  const word =
    (((major / 10) & 0x0f) << 28) |
    ((major % 10) << 24) |
    ((minor & 0x0f) << 20);
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(word >>> 0, 0);
  bytes.writeUInt16BE(0, 4);
  bytes.writeUInt8(0, 6);
  bytes.writeUInt8(0, 7);
  return bytes;
};

export const labviewContainer = (): Buffer =>
  buildLabviewRsrc([
    { ident: "vers", sections: [labviewVersionSection()] },
    {
      ident: "DFDS",
      sections: [labviewZlibSection("hello"), Buffer.from("raw!")],
    },
  ]);

/** Encrypt bytes with pylabview's xor8320 stream (the inverse of its decrypt). */
export const labviewXor8320 = (data: Buffer): Buffer => {
  const out = Buffer.allocUnsafe(data.length);
  let key = 0xed_b8_83_20;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index] ?? 0;
    out[index] = (key ^ value) & 0xff;
    key = (value ^ ((key << 1) | (key >>> 31))) >>> 0;
  }
  return out;
};

export interface ZipMemberFixture {
  readonly name: string;
  readonly content: Buffer;
  readonly utf8?: boolean;
  readonly encrypted?: boolean;
  readonly extra?: Buffer;
  /** Recorded name bytes, for names in a legacy encoding. */
  readonly rawName?: Buffer;
  /** Write both sizes through the Zip64 extra field, as a large archive does. */
  readonly zip64?: { readonly bytes: bigint; readonly storedBytes: bigint };
}

/** Build a stored-method ZIP archive with the given file members. */
export const labviewZipArchive = (
  members: readonly ZipMemberFixture[],
): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name =
      member.rawName ??
      Buffer.from(member.name, member.utf8 === true ? "utf8" : "latin1");
    let extra = member.extra ?? Buffer.alloc(0);
    if (member.zip64 !== undefined) {
      const field = Buffer.alloc(4 + 16);
      field.writeUInt16LE(0x00_01, 0);
      field.writeUInt16LE(16, 2);
      field.writeBigUInt64LE(member.zip64.bytes, 4);
      field.writeBigUInt64LE(member.zip64.storedBytes, 12);
      extra = Buffer.concat([extra, field]);
    }
    const size =
      member.zip64 === undefined ? member.content.length : 0xff_ff_ff_ff;
    const flags =
      (member.utf8 === true ? 0x08_00 : 0) |
      (member.encrypted === true ? 0x00_01 : 0);
    const checksum = crc32(member.content) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const localBytes = Buffer.concat([local, name, extra, member.content]);
    locals.push(localBytes);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name, extra]));
    offset += localBytes.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, end]);
};
