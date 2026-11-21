import { crc32, deflateRawSync } from "node:zlib";

/** One archive member; the overrides let a test frame what a real writer would not. */
export interface ZipMember {
  readonly name: string;
  readonly data?: string | Uint8Array;
  /** 0 stores, 8 deflates; another method stores the data under that number. */
  readonly method?: number;
  readonly declaredSize?: number;
  readonly crc?: number;
  /** General purpose flags; bit 0 marks the member encrypted. */
  readonly flags?: number;
  /** "Version made by": its high byte names the host, 0 for MS-DOS and 3 for Unix. */
  readonly madeBy?: number;
  /** External attributes; a slash-ended name gets the MS-DOS directory bit. */
  readonly external?: number;
  readonly centralExtra?: Uint8Array;
  /** Keep a local record without listing it in the central directory. */
  readonly listed?: boolean;
  /** A contradictory central size, without changing the local record. */
  readonly centralCompressedSize?: number;
}

const UTF8_NAME = 0x800;

/** A version-1 Info-ZIP Unicode Path claim bound to the stored filename bytes. */
export const unicodePathExtra = (
  name: string | Uint8Array,
  path: string | Uint8Array,
): Buffer => {
  const text = Buffer.from(path);
  const field = Buffer.alloc(9 + text.length);
  field.writeUInt16LE(0x7075);
  field.writeUInt16LE(field.length - 4, 2);
  field[4] = 1;
  field.writeUInt32LE(
    crc32(typeof name === "string" ? Buffer.from(name) : name),
    5,
  );
  text.copy(field, 9);
  return field;
};

/** A zip archive of the members in order, framed from the PKWARE APPNOTE records. */
export const zipArchive = (members: readonly ZipMember[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let listed = 0;
  let offset = 0;
  for (const member of members) {
    const content = Buffer.from(member.data ?? "");
    const method = member.method ?? 8;
    const stored = method === 8 ? deflateRawSync(content) : content;
    const name = Buffer.from(member.name);
    const flags =
      (member.flags ?? 0) |
      (/^[\x20-\x7e]*$/u.test(member.name) ? 0 : UTF8_NAME);
    const fields = {
      method,
      flags,
      crc: member.crc ?? crc32(content),
      compressed: stored.length,
      size: member.declaredSize ?? content.length,
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(fields.flags, 6);
    local.writeUInt16LE(fields.method, 8);
    local.writeUInt16LE(0x5021, 12); // 2020-01-01, DOS date.
    local.writeUInt32LE(fields.crc, 14);
    local.writeUInt32LE(fields.compressed, 18);
    local.writeUInt32LE(fields.size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(member.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(fields.flags, 8);
    central.writeUInt16LE(fields.method, 10);
    central.writeUInt16LE(0x5021, 14);
    central.writeUInt32LE(fields.crc, 16);
    central.writeUInt32LE(
      member.centralCompressedSize ?? fields.compressed,
      20,
    );
    central.writeUInt32LE(fields.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(member.centralExtra?.length ?? 0, 30);
    central.writeUInt32LE(
      member.external ?? (member.name.endsWith("/") ? 0x10 : 0),
      38,
    );
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    if (member.listed !== false) {
      listed += 1;
      centrals.push(central, name);
      if (member.centralExtra !== undefined)
        centrals.push(Buffer.from(member.centralExtra));
    }
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // Past 65,535 members the 16-bit counts wrap, as writers without Zip64 leave them.
  end.writeUInt16LE(listed & 0xffff, 8);
  end.writeUInt16LE(listed & 0xffff, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

/** A minimal OpenDocument text: the stored `mimetype` first, then its content and manifest, then any other members. */
export const odtArchive = (
  paragraph: string,
  others: readonly ZipMember[] = [],
): Buffer =>
  zipArchive([
    {
      name: "mimetype",
      data: "application/vnd.oasis.opendocument.text",
      method: 0,
    },
    {
      name: "content.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><text:p>${paragraph}</text:p></office:text></office:body></office:document-content>
`,
    },
    {
      name: "META-INF/manifest.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>
`,
    },
    ...others,
  ]);

const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;

/** An archive of `count` empty stored entries named `e/0`, `e/1` and so on, written straight into one buffer. */
export const emptyEntriesArchive = (count: number): Buffer => {
  const names = Array.from({ length: count }, (_, index) =>
    Buffer.from(`e/${String(index)}`),
  );
  const named = names.reduce((total, name) => total + name.length, 0);
  const directory = 30 * count + named;
  const zip64 = count > 0xffff;
  const zip64Bytes = zip64 ? ZIP64_END_BYTES + ZIP64_LOCATOR_BYTES : 0;
  const archive = Buffer.alloc(
    directory + 46 * count + named + zip64Bytes + 22,
  );
  let local = 0;
  let central = directory;
  for (const name of names) {
    archive.writeUInt32LE(0x04034b50, local);
    archive.writeUInt16LE(20, local + 4);
    archive.writeUInt16LE(name.length, local + 26);
    name.copy(archive, local + 30);
    archive.writeUInt32LE(0x02014b50, central);
    archive.writeUInt16LE(20, central + 4);
    archive.writeUInt16LE(20, central + 6);
    archive.writeUInt16LE(name.length, central + 28);
    archive.writeUInt32LE(local, central + 42);
    name.copy(archive, central + 46);
    local += 30 + name.length;
    central += 46 + name.length;
  }
  const directorySize = central - directory;
  if (zip64)
    zip64Ending(central, count, directorySize, directory).copy(
      archive,
      central,
    );
  const classic = central + zip64Bytes;
  archive.writeUInt32LE(0x06054b50, classic);
  archive.writeUInt16LE(Math.min(count, 0xffff), classic + 8);
  archive.writeUInt16LE(Math.min(count, 0xffff), classic + 10);
  archive.writeUInt32LE(directorySize, classic + 12);
  archive.writeUInt32LE(directory, classic + 16);
  return archive;
};

const zip64Ending = (
  end: number,
  entries: number,
  size: number,
  offset: number,
  extension: Uint8Array = new Uint8Array(),
): Buffer => {
  const recordBytes = ZIP64_END_BYTES + extension.length;
  const ending = Buffer.alloc(recordBytes + ZIP64_LOCATOR_BYTES);
  ending.writeUInt32LE(0x06064b50, 0);
  ending.writeBigUInt64LE(BigInt(recordBytes - 12), 4);
  ending.writeUInt16LE(45, 12);
  ending.writeUInt16LE(45, 14);
  ending.writeBigUInt64LE(BigInt(entries), 24);
  ending.writeBigUInt64LE(BigInt(entries), 32);
  ending.writeBigUInt64LE(BigInt(size), 40);
  ending.writeBigUInt64LE(BigInt(offset), 48);
  ending.set(extension, ZIP64_END_BYTES);
  ending.writeUInt32LE(0x07064b50, recordBytes);
  ending.writeBigUInt64LE(BigInt(end), recordBytes + 8);
  ending.writeUInt32LE(1, recordBytes + 16);
  return ending;
};

/**
 * The same archive ended by Zip64 records: a Zip64 end record and its locator,
 * and a classic one that defers to them, or with `sentinels` false keeps its
 * own counts, size and offset, as a writer may when they fit.
 */
export const withZip64End = (
  archive: Buffer,
  sentinels = true,
  extension: Uint8Array = new Uint8Array(),
): Buffer => {
  const end = archive.length - 22;
  const entries = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  const offset = archive.readUInt32LE(end + 16);
  const classic = Buffer.from(archive.subarray(end));
  if (sentinels) {
    classic.writeUInt16LE(0xffff, 8);
    classic.writeUInt16LE(0xffff, 10);
    classic.writeUInt32LE(0xffffffff, 12);
    classic.writeUInt32LE(0xffffffff, 16);
  }
  return Buffer.concat([
    archive.subarray(0, end),
    zip64Ending(end, entries, size, offset, extension),
    classic,
  ]);
};
