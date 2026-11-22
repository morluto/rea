import { deflateSync } from "node:zlib";

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
 * section data this reader parses. Names are omitted; the container's own
 * offsets are the fact under test, not a producer's naming.
 */
export const buildLabviewRsrc = (blocks: readonly BlockFixture[]): Buffer => {
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
      start.writeUInt32BE(0xffffffff, 4);
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
  const blockInfo = Buffer.concat([
    u32(blocks.length - 1),
    ...blockHeaders,
    ...sectionArrays,
  ]);
  const listHeader = Buffer.alloc(20);
  listHeader.writeUInt32BE(0, 0);
  listHeader.writeUInt32BE(0, 4);
  listHeader.writeUInt32BE(32, 8);
  listHeader.writeUInt32BE(52, 12);
  listHeader.writeUInt32BE(blockInfo.length, 16);
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

export const labviewZlibSection = (text: string): Buffer => {
  const encoded = deflateSync(Buffer.from(text, "latin1"));
  return Buffer.concat([u32(Buffer.byteLength(text, "latin1")), encoded]);
};

export const labviewVersionSection = (): Buffer => {
  const bytes = Buffer.alloc(12);
  bytes.write("11.0", 0, 4, "latin1");
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
