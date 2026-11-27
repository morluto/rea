import { gzipSync } from "node:zlib";

export interface BfltFixture {
  readonly revision?: number;
  readonly text?: Uint8Array;
  readonly data?: Uint8Array;
  readonly bssBytes?: number;
  readonly relocations?: readonly number[];
  readonly flags?: number;
  readonly entry?: number;
  readonly buildDate?: number;
  readonly stackSize?: number;
  /** Replaces the declared reloc_count, for truncated tables. */
  readonly relocCount?: number;
}

const HEADER = 64;

/** Build a synthetic bFLT: header, text, data, then the relocation table. */
export const bfltFile = (fixture: BfltFixture = {}): Buffer => {
  const text = Buffer.from(fixture.text ?? Buffer.from("TEXTtext"));
  const data = Buffer.from(fixture.data ?? Buffer.from("DATA"));
  const relocations = fixture.relocations ?? [];
  const dataStart = HEADER + text.length;
  const dataEnd = dataStart + data.length;
  const flags = fixture.flags ?? 0x01;
  const header = Buffer.alloc(HEADER);
  header.write("bFLT", 0, "latin1");
  header.writeUInt32BE(fixture.revision ?? 4, 4);
  header.writeUInt32BE(fixture.entry ?? HEADER, 8);
  header.writeUInt32BE(dataStart, 12);
  header.writeUInt32BE(dataEnd, 16);
  header.writeUInt32BE(dataEnd + (fixture.bssBytes ?? 16), 20);
  header.writeUInt32BE(fixture.stackSize ?? 0x1000, 24);
  header.writeUInt32BE(dataEnd, 28);
  header.writeUInt32BE(fixture.relocCount ?? relocations.length, 32);
  header.writeUInt32BE(flags, 36);
  header.writeUInt32BE(fixture.buildDate ?? 0, 40);
  const table = Buffer.alloc(relocations.length * 4);
  relocations.forEach((value, index) => table.writeUInt32BE(value, index * 4));
  if ((flags & 0x04) !== 0)
    return Buffer.concat([
      header,
      gzipSync(Buffer.concat([text, data, table])),
    ]);
  if ((flags & 0x08) !== 0)
    return Buffer.concat([
      header,
      text,
      gzipSync(Buffer.concat([data, table])),
    ]);
  return Buffer.concat([header, text, data, table]);
};
