/**
 * Required-split facts from a binary AndroidManifest.xml (AXML), the form
 * stored in an APK. The decoded-XML manifest parser cannot run here: the
 * JNI library scan reads the APK ZIP directly and never loads the APK in
 * JADX, so the manifest is only available as these binary bytes.
 *
 * The parser is deliberately narrow: it reads the string pool and the root
 * `<manifest>` start-element chunk, and nothing else. Any malformed or
 * truncated input yields null (undetermined) rather than a partial claim;
 * callers keep the previous inventory in that case.
 */

export interface AndroidManifestSplitTypes {
  readonly requiredSplitTypes: readonly string[];
  readonly splitRequired: boolean;
}

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_START_ELEMENT = 0x0102;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_BOOLEAN = 0x12;

/** Read one little-endian value with bounds checks; null when out of range. */
const reader = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (at: number): number | null =>
    at >= 0 && at < bytes.length ? view.getUint8(at) : null;
  const u16 = (at: number): number | null =>
    at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, true) : null;
  const u32 = (at: number): number | null =>
    at >= 0 && at + 4 <= bytes.length ? view.getUint32(at, true) : null;
  const i32 = (at: number): number | null =>
    at >= 0 && at + 4 <= bytes.length ? view.getInt32(at, true) : null;
  return { u8, u16, u32, i32 };
};

/** A parsed AXML string pool; strings decode lazily and never throw. */
const parseStringPool = (
  bytes: Uint8Array,
  read: ReturnType<typeof reader>,
  chunkStart: number,
  chunkSize: number,
): ((index: number) => string | null) | null => {
  const count = read.u32(chunkStart + 8);
  const flags = read.u32(chunkStart + 16);
  const stringsStart = read.u32(chunkStart + 20);
  if (
    count === null ||
    flags === null ||
    stringsStart === null ||
    count > 1_000_000 ||
    stringsStart > chunkSize
  )
    return null;
  const utf8 = (flags & 0x100) !== 0;
  const offsetsStart = chunkStart + 28;
  const offsetAt = (index: number): number | null => {
    const offset = read.u32(offsetsStart + index * 4);
    if (offset === null || offset > chunkSize) return null;
    return chunkStart + stringsStart + offset;
  };
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  const utf16Decoder = new TextDecoder("utf-16le", { fatal: true });
  return (index: number): string | null => {
    if (index < 0 || index >= count) return null;
    const at = offsetAt(index);
    if (at === null) return null;
    try {
      if (utf8) {
        // Lengths are varints: one byte, or two when the high bit is set.
        let cursor = at;
        const varint = (): number | null => {
          const first = read.u8(cursor);
          if (first === null) return null;
          cursor += 1;
          if ((first & 0x80) === 0) return first;
          const second = read.u8(cursor);
          if (second === null) return null;
          cursor += 1;
          return ((first & 0x7f) << 8) | second;
        };
        if (varint() === null) return null;
        const byteLength = varint();
        if (byteLength === null || byteLength > bytes.length) return null;
        if (cursor + byteLength > bytes.length) return null;
        const text = utf8Decoder.decode(
          bytes.subarray(cursor, cursor + byteLength),
        );
        return text;
      }
      const first = read.u16(at);
      if (first === null) return null;
      let length = first;
      let cursor = at + 2;
      if ((first & 0x8000) !== 0) {
        const second = read.u16(cursor);
        if (second === null) return null;
        length = ((first & 0x7fff) << 16) | second;
        cursor += 2;
      }
      if (length > bytes.length || cursor + length * 2 > bytes.length)
        return null;
      return utf16Decoder.decode(
        bytes.subarray(cursor, cursor + length * 2),
      );
    } catch {
      return null;
    }
  };
};

/**
 * Read the root manifest's required-split attributes from AXML bytes.
 * Returns null when the bytes are not a readable binary manifest, so the
 * caller cannot tell whether splits are required.
 */
export const readAndroidManifestSplitTypes = (
  bytes: Uint8Array,
): AndroidManifestSplitTypes | null => {
  const read = reader(bytes);
  if (
    read.u16(0) !== 0x0003 ||
    read.u16(2) !== 8 ||
    (read.u32(4) ?? Number.MAX_SAFE_INTEGER) > bytes.length
  )
    return null;
  let pool: ((index: number) => string | null) | null = null;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = read.u16(offset);
    const headerSize = read.u16(offset + 2);
    const size = read.u32(offset + 4);
    if (
      type === null ||
      headerSize === null ||
      size === null ||
      headerSize < 8 ||
      size < headerSize ||
      offset + size > bytes.length
    )
      return null;
    if (type === CHUNK_STRING_POOL) {
      pool = parseStringPool(bytes, read, offset, size);
      if (pool === null) return null;
    } else if (type === CHUNK_START_ELEMENT) {
      if (pool === null) return null;
      const strings = pool;
      const nameIndex = read.i32(offset + 20);
      const attributeStart = read.u16(offset + 24);
      const attributeSize = read.u16(offset + 26);
      const attributeCount = read.u16(offset + 28);
      if (
        nameIndex === null ||
        attributeStart === null ||
        attributeSize === null ||
        attributeCount === null ||
        attributeSize < 20 ||
        attributeCount > 10_000 ||
        strings(nameIndex) !== "manifest"
      )
        return null;
      let requiredSplitTypes: string[] = [];
      let splitRequired = false;
      for (let index = 0; index < attributeCount; index++) {
        const at = offset + attributeStart + index * attributeSize;
        if (at + 20 > offset + size) return null;
        const attrNameIndex = read.i32(at + 4);
        const rawValueIndex = read.i32(at + 8);
        const dataType = read.u8(at + 15);
        const data = read.u32(at + 16);
        if (attrNameIndex === null || dataType === null || data === null)
          return null;
        const attrName = strings(attrNameIndex);
        if (attrName !== "requiredSplitTypes" && attrName !== "isSplitRequired")
          continue;
        const stringValue = (): string | null => {
          if (dataType === TYPE_STRING) return strings(data);
          if (rawValueIndex !== null && rawValueIndex >= 0)
            return strings(rawValueIndex);
          return null;
        };
        if (attrName === "requiredSplitTypes") {
          const value = stringValue();
          if (value !== null)
            requiredSplitTypes = value
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0);
        } else if (dataType === TYPE_INT_BOOLEAN || dataType === TYPE_INT_DEC) {
          splitRequired = data !== 0;
        } else {
          const value = stringValue();
          if (value !== null) splitRequired = value === "true";
        }
      }
      return { requiredSplitTypes, splitRequired };
    }
    offset += size;
  }
  return null;
};
