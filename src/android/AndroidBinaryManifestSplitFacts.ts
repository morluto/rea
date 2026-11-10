import {
  BinaryFormatFailure,
  BinaryReader,
} from "../native/metadata/BinaryContainer.js";
import { err, ok, type Result } from "../domain/result.js";

/** Split declarations the binary manifest owns; a base APK's libraries may live in these splits. */
export interface AndroidBinaryManifestSplitFacts {
  readonly required_split_types: readonly string[] | null;
  readonly split_name: string | null;
  readonly is_split_required: boolean | null;
}

export type AndroidBinaryManifestSplitFailure = {
  readonly kind: "unsupported" | "malformed" | "capacity";
  readonly message: string;
};

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const MAXIMUM_STRING_BYTES = 1024 * 1024;
const MAXIMUM_STRINGS = 100_000;
const UTF8_FLAG = 0x100;
const ATTRIBUTE_ROWS = 20;
/** Framework resource IDs disambiguate the attributes from name spelling and prefix binding. */
const REQUIRED_SPLIT_TYPES_ID = 0x0101064c;
const IS_SPLIT_REQUIRED_ID = 0x0101064d;
const SPLIT_NAME_ID = 0x01010549;
const TYPE_STRING = 0x03;
const TYPE_INT_BOOLEAN = 0x12;

const decode = (
  bytes: Buffer,
  encoding: "utf-8" | "utf-16le",
): string | null => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** One or two UTF-8 bytes: the high bit selects the two-byte form. */
const utf8Length = (
  reader: BinaryReader,
  at: number,
  end: number,
): { readonly value: number; readonly consumed: number } | null => {
  if (at >= end) return null;
  const first = reader.bytes[at] ?? 0;
  if ((first & 0x80) === 0) return { value: first, consumed: 1 };
  if (at + 1 >= end) return null;
  return {
    value: ((first & 0x7f) << 8) | (reader.bytes[at + 1] ?? 0),
    consumed: 2,
  };
};

const readStringPool = (
  reader: BinaryReader,
  start: number,
  headerSize: number,
  chunkSize: number,
): Result<readonly (string | null)[], AndroidBinaryManifestSplitFailure> => {
  const count = reader.u32(start + 8);
  const flags = reader.u32(start + 16);
  const stringsStart = reader.u32(start + 20);
  const bad = (message: string) => err({ kind: "malformed" as const, message });
  if (count > MAXIMUM_STRINGS)
    return err({
      kind: "capacity",
      message: `The manifest string pool declares more than ${String(MAXIMUM_STRINGS)} entries.`,
    });
  if (headerSize < 28 || chunkSize < headerSize)
    return bad("The manifest string pool header is truncated.");
  if (count > (chunkSize - headerSize) / 4)
    return bad("The manifest string pool offsets leave the chunk.");
  if (stringsStart < headerSize || stringsStart > chunkSize)
    return bad("The manifest string pool data starts outside its chunk.");
  const dataStart = start + stringsStart;
  const dataEnd = start + chunkSize;
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: (string | null)[] = [];
  let budget = MAXIMUM_STRING_BYTES;
  for (let index = 0; index < count; index++) {
    const relative = reader.u32(start + headerSize + index * 4);
    let at = dataStart + relative;
    const fail = (): void => {
      strings.push(null);
    };
    if (at < dataStart || at >= dataEnd) {
      fail();
      continue;
    }
    let dataLength: number;
    let skip: number;
    if (!utf8) {
      if (at + 2 > dataEnd) {
        fail();
        continue;
      }
      dataLength = reader.u16(at) * 2;
      skip = 2;
    } else {
      const units = utf8Length(reader, at, dataEnd);
      const byteUnits =
        units === null
          ? null
          : utf8Length(reader, at + units.consumed, dataEnd);
      if (units === null || byteUnits === null) {
        fail();
        continue;
      }
      dataLength = byteUnits.value;
      skip = units.consumed + byteUnits.consumed;
    }
    const dataAt = at + skip;
    if (dataLength > budget || dataAt + dataLength > dataEnd) {
      fail();
      continue;
    }
    strings.push(
      decode(
        reader.range(dataAt, dataLength, "manifest string"),
        utf8 ? "utf-8" : "utf-16le",
      ),
    );
    budget -= dataLength;
  }
  return ok(strings);
};

const splitTypes = (value: string): readonly string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

interface StartElement {
  readonly name: string | null;
  readonly attributes: readonly {
    readonly namespace: string | null;
    readonly name: string | null;
    readonly resourceId: number | undefined;
    readonly raw: string | null;
    readonly dataType: number;
    readonly data: number;
  }[];
}

const readStartElement = (
  reader: BinaryReader,
  strings: readonly (string | null)[],
  resourceIds: readonly number[],
  start: number,
  chunkSize: number,
): StartElement | null => {
  // A start element begins with the common 16-byte ResXMLNode header, so the
  // attribute table starts at the chunk plus its header, not plus a node size.
  const attributeStart = reader.u16(start + 24);
  const attributeSize = reader.u16(start + 26);
  const attributeCount = reader.u16(start + 28);
  if (attributeSize < ATTRIBUTE_ROWS) return null;
  const name = strings[reader.u32(start + 20)] ?? null;
  const table = start + reader.u16(start + 2) + attributeStart;
  const attributes: StartElement["attributes"][number][] = [];
  for (let index = 0; index < attributeCount; index++) {
    const at = table + index * attributeSize;
    if (at < table || at + ATTRIBUTE_ROWS > start + chunkSize) return null;
    const nameIndex = reader.u32(at + 4);
    const rawValueIndex = reader.u32(at + 8);
    attributes.push({
      namespace: strings[reader.u32(at)] ?? null,
      name: strings[nameIndex] ?? null,
      resourceId: resourceIds[nameIndex],
      raw:
        rawValueIndex === 0xffffffff ? null : (strings[rawValueIndex] ?? null),
      dataType: reader.bytes[at + 15] ?? 0,
      data: reader.u32(at + 16),
    });
  }
  return { name, attributes };
};

/** Read only the split-declaration attributes from an admitted binary AndroidManifest.xml. */
export const readAndroidBinaryManifestSplitFacts = (
  bytes: Buffer,
): Result<
  AndroidBinaryManifestSplitFacts,
  AndroidBinaryManifestSplitFailure
> => {
  try {
    if (
      bytes.length < 8 ||
      bytes.readUInt16LE(0) !== RES_XML_TYPE ||
      bytes.readUInt16LE(2) !== 8
    )
      return err({
        kind: "unsupported",
        message: "The AndroidManifest.xml member is not a binary XML document.",
      });
    const reader = new BinaryReader(bytes, true);
    const declared = reader.u32(4);
    if (declared < 8 || declared > bytes.length)
      return err({
        kind: "malformed",
        message: "The binary XML document declares a size outside the member.",
      });
    const chunks: {
      type: number;
      start: number;
      headerSize: number;
      chunkSize: number;
    }[] = [];
    let start = 8;
    while (start + 8 <= declared) {
      const chunk = {
        type: reader.u16(start),
        headerSize: reader.u16(start + 2),
        start,
        chunkSize: reader.u32(start + 4),
      };
      if (
        chunk.chunkSize < 8 ||
        chunk.headerSize < 8 ||
        start + chunk.chunkSize > declared
      )
        return err({
          kind: "malformed",
          message: "A binary XML chunk declares a size outside the document.",
        });
      chunks.push(chunk);
      start += chunk.chunkSize;
    }
    const poolChunk = chunks.find(
      (chunk) => chunk.type === RES_STRING_POOL_TYPE,
    );
    if (poolChunk === undefined)
      return err({
        kind: "malformed",
        message: "The binary manifest has no string pool.",
      });
    const pool = readStringPool(
      reader,
      poolChunk.start,
      poolChunk.headerSize,
      poolChunk.chunkSize,
    );
    if (!pool.ok) return pool;
    const strings = pool.value;
    const resourceIds: number[] = [];
    for (const chunk of chunks) {
      if (chunk.type !== RES_XML_RESOURCE_MAP_TYPE) continue;
      for (
        let offset = chunk.start + chunk.headerSize;
        offset + 4 <= chunk.start + chunk.chunkSize;
        offset += 4
      )
        resourceIds.push(reader.u32(offset));
      break;
    }
    const manifest = chunks
      .filter((chunk) => chunk.type === RES_XML_START_ELEMENT_TYPE)
      .map((chunk) => {
        const el = readStartElement(
          reader,
          strings,
          resourceIds,
          chunk.start,
          chunk.chunkSize,
        );
        console.log("DBG", JSON.stringify(el?.name), el?.attributes.length);
        return el;
      })
      .find((element) => element?.name === "manifest");
    if (manifest === undefined || manifest === null)
      return err({
        kind: "malformed",
        message: "The binary manifest has no <manifest> start element.",
      });
    const android = manifest.attributes.filter(
      (attribute) => attribute.namespace === ANDROID_NS,
    );
    const toValue = (attribute: (typeof android)[number]): string | null =>
      attribute.dataType === TYPE_STRING
        ? (strings[attribute.data] ?? null)
        : attribute.raw;
    const find = (resourceId: number, name: string) =>
      android.find(
        (attribute) =>
          attribute.resourceId === resourceId || attribute.name === name,
      );
    const requiredSplitTypes = find(
      REQUIRED_SPLIT_TYPES_ID,
      "requiredSplitTypes",
    );
    const splitName = find(SPLIT_NAME_ID, "splitName");
    const requiredFlag = find(IS_SPLIT_REQUIRED_ID, "isSplitRequired");
    const isSplitRequired =
      requiredFlag === undefined
        ? null
        : requiredFlag.dataType === TYPE_INT_BOOLEAN
          ? requiredFlag.data !== 0
          : requiredFlag.dataType === TYPE_STRING
            ? (strings[requiredFlag.data] ?? null) === "true"
              ? true
              : (strings[requiredFlag.data] ?? null) === "false"
                ? false
                : null
            : null;
    const requiredValue =
      requiredSplitTypes === undefined ? null : toValue(requiredSplitTypes);
    return ok({
      required_split_types:
        requiredValue === null ? null : splitTypes(requiredValue),
      split_name: splitName === undefined ? null : toValue(splitName),
      is_split_required: isSplitRequired,
    });
  } catch (cause: unknown) {
    if (cause instanceof BinaryFormatFailure)
      return err({
        kind: cause.kind,
        message: cause.message,
      });
    throw cause;
  }
};
