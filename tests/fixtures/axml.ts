/** Synthetic Android binary XML (AXML) builders for reader tests. */

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};
const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};

export interface AxmlAttribute {
  readonly name: string;
  /** Namespace URI; omit for none. */
  readonly ns?: string;
  /** Literal string value (stored as the raw string). */
  readonly value?: string;
  /** Typed value when `value` is omitted: [dataType, data]. */
  readonly typed?: readonly [number, number];
}

export type AxmlEvent =
  | { readonly kind: "startNs"; readonly prefix: string; readonly uri: string }
  | { readonly kind: "endNs"; readonly prefix: string; readonly uri: string }
  | {
      readonly kind: "start";
      readonly name: string;
      readonly ns?: string;
      readonly attrs?: readonly AxmlAttribute[];
      readonly comment?: string;
    }
  | {
      readonly kind: "end";
      readonly name: string;
      readonly ns?: string;
      readonly comment?: string;
    }
  | {
      readonly kind: "cdata";
      readonly text: string;
      readonly comment?: string;
    };

export interface AxmlOptions {
  /** Encode the pool as UTF-8 instead of UTF-16LE. */
  readonly utf8?: boolean;
  /** Resource IDs for android-prefixed attribute names, indexed by string. */
  readonly resourceIds?: Readonly<Record<string, number>>;
  /** Extra unreachable resource-map entries appended after the pool ids. */
  readonly resourceMapExtra?: number;
  /** Override the declared document size. */
  readonly declaredSize?: number;
  /** Drop the final byte count to this length (truncation). */
  readonly truncate?: number;
  /** Append chunks after the events. */
  readonly tailChunks?: readonly Buffer[];
}

const utf16String = (text: string): Buffer =>
  Buffer.concat([
    text.length > 0x7fff
      ? Buffer.concat([
          u16(((text.length >> 16) & 0x7fff) | 0x8000),
          u16(text.length & 0xffff),
        ])
      : u16(text.length),
    Buffer.from(text, "utf16le"),
    Buffer.alloc(2),
  ]);

/** AXML UTF-8 length specs use one byte below 0x80, two bytes above. */
const utf8Length = (value: number): Buffer =>
  value < 0x80
    ? Buffer.from([value])
    : Buffer.from([(value >> 8) | 0x80, value & 0xff]);

const utf8String = (text: string): Buffer => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([
    utf8Length(text.length),
    utf8Length(bytes.length),
    bytes,
    Buffer.alloc(1),
  ]);
};

const NO_INDEX = 0xffffffff;

class PoolBuilder {
  readonly strings: string[] = [];
  readonly index = new Map<string, number>();

  add(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.strings.length;
    this.strings.push(value);
    this.index.set(value, next);
    return next;
  }
}

const chunk = (type: number, headerSize: number, body: Buffer): Buffer =>
  Buffer.concat([
    u16(type),
    u16(headerSize),
    u32(AXML_CHUNK_HEADER_BYTES + body.length),
    body,
  ]);

const AXML_CHUNK_HEADER_BYTES = 8;

/**
 * Build a binary XML document from an event list. String pool entries are
 * collected in first-use order; the optional resource map aligns to those
 * indices so android-prefixed names resolve without a namespace URI.
 */
export const buildAxml = (
  events: readonly AxmlEvent[],
  options: AxmlOptions = {},
): Buffer => {
  const pool = new PoolBuilder();
  for (const event of events) {
    if (event.kind === "startNs" || event.kind === "endNs") {
      pool.add(event.prefix);
      pool.add(event.uri);
    } else if (event.kind === "start" || event.kind === "end") {
      if (event.ns !== undefined) pool.add(event.ns);
      pool.add(event.name);
      if (event.comment !== undefined) pool.add(event.comment);
      if (event.kind === "start")
        for (const attr of event.attrs ?? []) {
          if (attr.ns !== undefined) pool.add(attr.ns);
          pool.add(attr.name);
          if (attr.value !== undefined) pool.add(attr.value);
        }
    } else {
      pool.add(event.text);
      if (event.comment !== undefined) pool.add(event.comment);
    }
  }

  const encode = options.utf8 === true ? utf8String : utf16String;
  const offsets: number[] = [];
  let cursor = 0;
  const stringBytes = pool.strings.map((text) => {
    const encoded = encode(text);
    offsets.push(cursor);
    cursor += encoded.length;
    return encoded;
  });
  const headerSize = 28;
  const stringsStart = headerSize + pool.strings.length * 4;
  const poolBody = Buffer.concat([
    u32(pool.strings.length),
    u32(0),
    u32(options.utf8 === true ? 0x00000100 : 0),
    u32(stringsStart),
    u32(0),
    ...offsets.map(u32),
    ...stringBytes,
  ]);
  const poolChunk = chunk(0x0001, headerSize, poolBody);

  const node = (type: number, body: Buffer, comment = NO_INDEX): Buffer =>
    Buffer.concat([
      u16(type),
      u16(16),
      u32(16 + body.length),
      u32(1),
      u32(comment),
      body,
    ]);

  const eventChunks = events.map((event) => {
    if (event.kind === "startNs")
      return node(
        0x0100,
        Buffer.concat([u32(pool.add(event.prefix)), u32(pool.add(event.uri))]),
      );
    if (event.kind === "endNs")
      return node(
        0x0101,
        Buffer.concat([u32(pool.add(event.prefix)), u32(pool.add(event.uri))]),
      );
    if (event.kind === "end")
      return node(
        0x0103,
        Buffer.concat([
          u32(event.ns === undefined ? NO_INDEX : pool.add(event.ns)),
          u32(pool.add(event.name)),
        ]),
        event.comment === undefined ? NO_INDEX : pool.add(event.comment),
      );
    if (event.kind === "cdata") {
      const dataIndex = pool.add(event.text);
      // ResXMLTree_cdataExt: data index + Res_value{size=8,res0=0,type=string,data}.
      return node(
        0x0104,
        Buffer.concat([
          u32(dataIndex),
          u16(8),
          Buffer.from([0, 0x03]),
          u32(dataIndex),
        ]),
        event.comment === undefined ? NO_INDEX : pool.add(event.comment),
      );
    }
    const attrs = event.attrs ?? [];
    const attrStart = 20;
    const attrSize = 20;
    const records = attrs.map((attr) => {
      const raw = attr.value === undefined ? NO_INDEX : pool.add(attr.value);
      const [type, data] = attr.typed ?? [0x03, raw];
      return Buffer.concat([
        u32(attr.ns === undefined ? NO_INDEX : pool.add(attr.ns)),
        u32(pool.add(attr.name)),
        u32(raw),
        Buffer.from([8, 0, 0, type]),
        u32((type === 0x03 && raw !== NO_INDEX ? raw : data) >>> 0),
      ]);
    });
    const ext = Buffer.concat([
      u32(event.ns === undefined ? NO_INDEX : pool.add(event.ns)),
      u32(pool.add(event.name)),
      u16(attrStart),
      u16(attrSize),
      u16(attrs.length),
      u16(0),
      u16(0),
      u16(0),
      ...records,
    ]);
    // Start-element chunk carries a larger header than other nodes.
    const size = 16 + ext.length;
    return Buffer.concat([
      u16(0x0102),
      u16(36),
      u32(size),
      u32(1),
      u32(event.comment === undefined ? NO_INDEX : pool.add(event.comment)),
      ext,
    ]);
  });

  let resMap: Buffer = Buffer.alloc(0);
  if (
    options.resourceIds !== undefined ||
    options.resourceMapExtra !== undefined
  ) {
    const ids = pool.strings.map((text) => options.resourceIds?.[text] ?? 0);
    for (let i = 0; i < (options.resourceMapExtra ?? 0); i++) ids.push(0);
    resMap = chunk(0x0180, 8, Buffer.concat(ids.map((id) => u32(id))));
  }

  const body = Buffer.concat([
    poolChunk,
    resMap,
    ...eventChunks,
    ...(options.tailChunks ?? []),
  ]);
  const declared = options.declaredSize ?? 8 + body.length;
  let file = Buffer.concat([u16(0x0003), u16(8), u32(declared), body]);
  if (options.truncate !== undefined) file = file.subarray(0, options.truncate);
  return file;
};

/** A minimal manifest-shaped document with common typed attributes. */
export const AXML_MANIFEST_EVENTS: readonly AxmlEvent[] = [
  {
    kind: "startNs",
    prefix: "android",
    uri: "http://schemas.android.com/apk/res/android",
  },
  {
    kind: "start",
    name: "manifest",
    attrs: [
      { name: "package", value: "com.example.app" },
      {
        name: "versionCode",
        ns: "http://schemas.android.com/apk/res/android",
        typed: [0x10, 3],
      },
      {
        name: "versionName",
        ns: "http://schemas.android.com/apk/res/android",
        value: "1.0",
      },
    ],
  },
  { kind: "start", name: "application" },
  {
    kind: "start",
    name: "activity",
    attrs: [
      {
        name: "name",
        ns: "http://schemas.android.com/apk/res/android",
        value: ".MainActivity",
      },
      {
        name: "exported",
        ns: "http://schemas.android.com/apk/res/android",
        typed: [0x12, 1],
      },
    ],
  },
  { kind: "end", name: "activity" },
  { kind: "end", name: "application" },
  { kind: "end", name: "manifest" },
  {
    kind: "endNs",
    prefix: "android",
    uri: "http://schemas.android.com/apk/res/android",
  },
];
