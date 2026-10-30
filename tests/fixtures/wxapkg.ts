/** Synthetic WeChat mini-program package (wxapkg) builders for reader tests. */

export interface WxapkgMember {
  readonly path: string;
  readonly data: string | Buffer;
  /** Override the declared member offset (absolute file position). */
  readonly offset?: number;
  /** Override the declared member byte size. */
  readonly size?: number;
}

export interface WxapkgOptions {
  readonly firstMark?: number;
  readonly lastMark?: number;
  readonly info?: number;
  readonly declaredFileCount?: number;
  readonly declaredIndexLength?: number;
  readonly declaredDataLength?: number;
  /** Override the encoded row's name-length field for every member. */
  readonly nameLength?: number;
  /** Bytes appended to the table region beyond the declared rows. */
  readonly tablePadding?: number;
  /** Declare every member after the first at the first member's offset. */
  readonly aliasOffsets?: boolean;
  /** Replace the whole package prefix (encrypted variants). */
  readonly magic?: Buffer;
  /** Truncate the final package to this many bytes. */
  readonly truncate?: number;
}

const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");
const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

/** Encrypted PC-client package prefix, without plaintext members. */
export const wxapkgEncryptedBytes = (): Buffer =>
  Buffer.concat([Buffer.from("V1MMWX", "latin1"), Buffer.alloc(64)]);

/** Plain wxapkg: 18-byte header, name/offset/size rows, then verbatim data. */
export const buildWxapkg = (
  members: readonly WxapkgMember[],
  options: WxapkgOptions = {},
): Buffer => {
  if (options.magic !== undefined)
    return Buffer.concat([
      options.magic,
      ...members.map(({ data }) =>
        typeof data === "string" ? utf8(data) : data,
      ),
    ]);
  const names = members.map(({ path }) => utf8(path));
  // Encoded rows carry the real name bytes regardless of any declared override.
  const rowBytes = names.reduce((sum, name) => sum + 12 + name.length, 0);
  const indexLength =
    options.declaredIndexLength ?? rowBytes + (options.tablePadding ?? 0);
  const dataStart = 18 + indexLength;
  let cursor = dataStart;
  const rows: Buffer[] = [];
  const payload: Buffer[] = [];
  let firstOffset: number | undefined;
  members.forEach((member, index) => {
    const name = names[index]!;
    const data =
      typeof member.data === "string" ? utf8(member.data) : member.data;
    const aliased =
      options.aliasOffsets === true && index > 0 && firstOffset !== undefined;
    const offset = aliased ? firstOffset! : (member.offset ?? cursor);
    const size = member.size ?? data.length;
    firstOffset ??= offset;
    rows.push(
      u32(options.nameLength ?? name.length),
      name,
      u32(offset),
      u32(size),
    );
    if (!aliased) {
      payload.push(data);
      if (offset === cursor) cursor = offset + size;
    }
  });
  const dataLength =
    options.declaredDataLength ?? Math.max(0, cursor - dataStart);
  const header = Buffer.concat([
    Buffer.from([options.firstMark ?? 0xbe]),
    u32(options.info ?? 0),
    u32(indexLength),
    u32(dataLength),
    Buffer.from([options.lastMark ?? 0xed]),
    u32(options.declaredFileCount ?? members.length),
  ]);
  const table = Buffer.concat([
    ...rows,
    Buffer.alloc(options.tablePadding ?? 0),
  ]);
  let bytes = Buffer.concat([header, table, ...payload]);
  if (options.truncate !== undefined)
    bytes = bytes.subarray(0, options.truncate);
  return bytes;
};
