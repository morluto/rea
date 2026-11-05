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
}

const UTF8_NAME = 0x800;

/** A zip archive of the members in order, framed from the PKWARE APPNOTE records. */
export const zipArchive = (members: readonly ZipMember[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
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
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(fields.flags, 8);
    central.writeUInt16LE(fields.method, 10);
    central.writeUInt16LE(0x5021, 14);
    central.writeUInt32LE(fields.crc, 16);
    central.writeUInt32LE(fields.compressed, 20);
    central.writeUInt32LE(fields.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(member.name.endsWith("/") ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
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
