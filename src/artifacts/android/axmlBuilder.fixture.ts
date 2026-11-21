/**
 * Minimal compiled-XML (AXML) builder for hostile-input tests. It writes the
 * chunk layout the reader consumes; producer-shaped manifests come from the
 * aapt2 goldens instead.
 */
const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};
const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
};

export const NO_INDEX = 0xffffffff;

/** One chunk: `headerExtra` follows the 8-byte header, then `payload`. */
export const chunk = (
  type: number,
  headerExtra: Buffer,
  payload: Buffer,
): Buffer => {
  const headerSize = 8 + headerExtra.length;
  return Buffer.concat([
    u16(type),
    u16(headerSize),
    u32(headerSize + payload.length),
    headerExtra,
    payload,
  ]);
};

const utf16 = (text: string): Buffer => {
  const length = text.length;
  const prefix =
    length < 0x8000
      ? u16(length)
      : Buffer.concat([u16(0x8000 | (length >>> 16)), u16(length & 0xffff)]);
  return Buffer.concat([prefix, Buffer.from(text, "utf16le"), u16(0)]);
};

/** UTF-8 string: char length, byte length (1 or 2 bytes each), bytes, NUL. */
const utf8 = (text: string): Buffer => {
  const bytes = Buffer.from(text, "utf8");
  const prefix = (value: number): Buffer =>
    value < 0x80
      ? Buffer.from([value])
      : Buffer.from([0x80 | (value >>> 8), value & 0xff]);
  return Buffer.concat([
    prefix(text.length),
    prefix(bytes.length),
    bytes,
    Buffer.from([0]),
  ]);
};

/**
 * String pool in UTF-16 (default) or UTF-8; `extraOffsets` are appended and
 * may repeat a string.
 */
export const stringPool = (
  strings: readonly string[],
  extraOffsets: readonly number[] = [],
  encoding: "utf16" | "utf8" = "utf16",
): Buffer => {
  const encoded = strings.map(encoding === "utf8" ? utf8 : utf16);
  const offsets: number[] = [];
  let at = 0;
  for (const bytes of encoded) {
    offsets.push(at);
    at += bytes.length;
  }
  const all = [...offsets, ...extraOffsets.map((index) => offsets[index]!)];
  const stringsStart = 28 + all.length * 4;
  const header = Buffer.concat([
    u32(all.length),
    u32(0),
    u32(encoding === "utf8" ? 0x100 : 0),
    u32(stringsStart),
    u32(0),
  ]);
  return chunk(0x0001, header, Buffer.concat([...all.map(u32), ...encoded]));
};

export interface RawAttribute {
  readonly namespace?: number;
  readonly name: number;
  /** String index for `string` values; the literal itself otherwise. */
  readonly value: number;
  readonly type?: "string" | "int" | "boolean" | "reference";
}

const TYPE_CODES = { string: 0x03, int: 0x10, boolean: 0x12, reference: 0x01 };

const attribute = (raw: RawAttribute): Buffer =>
  Buffer.concat([
    u32(raw.namespace ?? NO_INDEX),
    u32(raw.name),
    u32(raw.type === undefined || raw.type === "string" ? raw.value : NO_INDEX),
    u16(8),
    Buffer.from([0, TYPE_CODES[raw.type ?? "string"]]),
    u32(raw.value),
  ]);

/** START_ELEMENT; `declaredCount` may lie about the attributes present. */
export const startElement = (
  name: number,
  attributes: readonly RawAttribute[],
  declaredCount: number = attributes.length,
  attributeStart: number = 20,
): Buffer => {
  const extension = Buffer.concat([
    u32(NO_INDEX),
    u32(name),
    u16(attributeStart),
    u16(20),
    u16(declaredCount),
    u16(0),
    u16(0),
    u16(0),
  ]);
  return chunk(
    0x0102,
    Buffer.concat([u32(1), u32(NO_INDEX)]),
    Buffer.concat([extension, ...attributes.map(attribute)]),
  );
};

export const endElement = (name: number): Buffer =>
  chunk(
    0x0103,
    Buffer.concat([u32(1), u32(NO_INDEX)]),
    Buffer.concat([u32(NO_INDEX), u32(name)]),
  );

/** An unrecognised chunk whose payload is the bytes of one valid attribute. */
export const foreignChunkCarryingAttribute = (raw: RawAttribute): Buffer =>
  chunk(0x9999, Buffer.alloc(0), attribute(raw));

export const document = (...chunks: readonly Buffer[]): Buffer => {
  const body = Buffer.concat(chunks);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
};

/** Repeat one string's payload to make an `n`-character UTF-16 string. */
export const giantString = (characters: number): string =>
  "a".repeat(characters);
