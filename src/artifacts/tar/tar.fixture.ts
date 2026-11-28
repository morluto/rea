import { gzipSync } from "node:zlib";

/** One tar member for {@link tarFixture}, written from the POSIX ustar layout. */
export interface TarFixtureMember {
  readonly name: string;
  readonly data?: Buffer | string;
  /** Typeflag character; `0` regular file by default. */
  readonly type?: string;
  readonly mode?: number;
  readonly linkname?: string;
  /** `ustar` (POSIX, default) or `gnu` magic. */
  readonly dialect?: "ustar" | "gnu";
  /** Split a long name into the ustar prefix field. */
  readonly prefix?: string;
  /** Pax records written as a preceding `x` header. */
  readonly pax?: Readonly<Record<string, string>>;
  /** Declared size, when it should differ from the data length. */
  readonly size?: number;
}

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\u0000`;

/** One 512-byte ustar header with a correct checksum. */
export const tarHeader = (member: TarFixtureMember, size: number): Buffer => {
  const block = Buffer.alloc(512);
  block.write(member.name, 0, 100, "utf8");
  block.write(octal(member.mode ?? 0o644, 8), 100, "latin1");
  block.write(octal(1000, 8), 108, "latin1");
  block.write(octal(1000, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(1_700_000_000, 12), 136, "latin1");
  block.write(member.type ?? "0", 156, "latin1");
  if (member.linkname !== undefined)
    block.write(member.linkname, 157, 100, "utf8");
  if (member.dialect === "gnu") block.write("ustar  \u0000", 257, "latin1");
  else block.write("ustar\u000000", 257, "latin1");
  block.write("builder", 265, "latin1");
  block.write("staff", 297, "latin1");
  if (member.prefix !== undefined) block.write(member.prefix, 345, 155, "utf8");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "latin1");
  return block;
};

const padded = (data: Buffer): Buffer =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

const paxRecords = (records: Readonly<Record<string, string>>): Buffer =>
  Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(body) + 1;
      while (String(length).length + Buffer.byteLength(body) !== length)
        length = String(length).length + Buffer.byteLength(body);
      return Buffer.from(`${String(length)}${body}`, "utf8");
    }),
  );

/** The member blocks, without the end-of-archive marker. */
export const tarMembers = (members: readonly TarFixtureMember[]): Buffer =>
  Buffer.concat(
    members.flatMap((member) => {
      const data = Buffer.from(member.data ?? "");
      const blocks: Buffer[] = [];
      if (member.pax !== undefined) {
        const pax = paxRecords(member.pax);
        blocks.push(
          tarHeader({ name: "PaxHeader", type: "x" }, pax.length),
          padded(pax),
        );
      }
      blocks.push(tarHeader(member, member.size ?? data.length), padded(data));
      return blocks;
    }),
  );

/** A complete tar archive: members, two zero blocks and 10 KiB record padding. */
export const tarFixture = (members: readonly TarFixtureMember[]): Buffer => {
  const body = Buffer.concat([tarMembers(members), Buffer.alloc(1024)]);
  return Buffer.concat([
    body,
    Buffer.alloc((10240 - (body.length % 10240)) % 10240),
  ]);
};

export const gzipTarFixture = (members: readonly TarFixtureMember[]): Buffer =>
  gzipSync(tarFixture(members));

/** Add one RFC 1952 extra subfield to a gzipSync member. */
export const withGzipExtraField = (gzip: Buffer, size: number): Buffer => {
  const header = Buffer.from(gzip.subarray(0, 10));
  header[3] = 4;
  const extra = Buffer.alloc(6 + size);
  extra.writeUInt16LE(4 + size);
  extra.write("RA", 2);
  extra.writeUInt16LE(size, 4);
  return Buffer.concat([header, extra, gzip.subarray(10)]);
};

/** A small release-like tree: a `./` root, a directory, an executable and a symlink. */
export const RELEASE_TAR_MEMBERS: readonly TarFixtureMember[] = [
  { name: "./", type: "5", mode: 0o755 },
  { name: "./app/", type: "5", mode: 0o755 },
  { name: "./app/run.x86_64", data: "\u007fELF-not-really", mode: 0o755 },
  { name: "./app/data.pck", data: "GDPC-not-really" },
  { name: "./app/latest", type: "2", linkname: "run.x86_64", mode: 0o777 },
];
