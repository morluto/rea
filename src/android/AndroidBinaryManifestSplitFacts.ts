import {
  BinaryFormatFailure,
  BinaryReader,
} from "../native/metadata/BinaryContainer.js";
import { err, ok, type Result } from "../domain/result.js";

/**
 * Split types are retained as declared comma-separated tokens. A literal can
 * hold one per string-pool byte, so the number retained is bounded and the
 * declaration reports its complete count alongside them.
 */
export interface AndroidBinaryManifestSplitTypeList {
  readonly types: readonly string[];
  readonly declared_count: number;
  readonly truncated: boolean;
}

/** Split declarations the binary manifest owns; a base APK's libraries may live in these splits. */
export interface AndroidBinaryManifestSplitFacts {
  /**
   * `null` when the declaration is absent; `unknown` when it is present but not
   * a literal. A list keeps its first `MAXIMUM_REQUIRED_SPLIT_TYPES` tokens and
   * reports the full count, so a bounded declaration is not read as complete.
   */
  readonly required_split_types:
    | AndroidBinaryManifestSplitTypeList
    | "unknown"
    | null;
  readonly split_name: string | null;
  /** `null` when the declaration is absent; `unknown` when it is present but not a literal. */
  readonly is_split_required: boolean | "unknown" | null;
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
/** Retained split-type tokens; one joined literal can otherwise become a million strings. */
const MAXIMUM_REQUIRED_SPLIT_TYPES = 64;
const UTF8_FLAG = 0x100;
const ATTRIBUTE_ROWS = 20;
const RES_XML_NODE_HEADER = 16;
/** ResXMLTree_attrExt, which a start element always carries before its attribute table. */
const RES_XML_ATTR_EXT = 20;
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

/**
 * A string-pool length prefix. ResStringPool encodes both lengths the same
 * way: a word whose high bit says whether a continuation word follows, with
 * the payload's high bits carried in it. UTF-8 uses bytes, UTF-16 uses 16-bit
 * code units, so callers need the word width to translate the raw value.
 */
const readLengthPrefix = (
  reader: BinaryReader,
  at: number,
  end: number,
  wordBytes: 1 | 2,
): { readonly value: number; readonly consumed: number } | null => {
  const readWord = (offset: number): number | null => {
    if (offset + wordBytes > end) return null;
    return wordBytes === 1 ? (reader.bytes[offset] ?? 0) : reader.u16(offset);
  };
  const first = readWord(at);
  if (first === null) return null;
  const highBit = wordBytes === 1 ? 0x80 : 0x8000;
  const payloadMask = highBit - 1;
  if ((first & highBit) === 0) return { value: first, consumed: wordBytes };
  const continuation = readWord(at + wordBytes);
  if (continuation === null) return null;
  return {
    value: ((first & payloadMask) << 16) | continuation,
    consumed: wordBytes * 2,
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
      const units = readLengthPrefix(reader, at, dataEnd, 2);
      if (units === null) {
        fail();
        continue;
      }
      dataLength = units.value * 2;
      skip = units.consumed;
    } else {
      const units = readLengthPrefix(reader, at, dataEnd, 1);
      const byteUnits =
        units === null
          ? null
          : readLengthPrefix(reader, at + units.consumed, dataEnd, 1);
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

const splitTypes = (value: string): AndroidBinaryManifestSplitTypeList => {
  const types: string[] = [];
  let declaredCount = 0;
  for (const part of value.split(","))
    if (part.trim().length > 0) {
      declaredCount += 1;
      if (types.length < MAXIMUM_REQUIRED_SPLIT_TYPES)
        types.push(part.trim());
    }
  return {
    types,
    declared_count: declaredCount,
    truncated: declaredCount > types.length,
  };
};

interface Chunk {
  readonly type: number;
  readonly start: number;
  readonly headerSize: number;
  readonly chunkSize: number;
}

/**
 * Visit each declared chunk in document order without retaining them. The
 * visitor returns false to stop; the walk still fails closed on a chunk whose
 * declared extent leaves the document.
 */
const walkChunks = (
  reader: BinaryReader,
  declared: number,
  visit: (chunk: Chunk) => boolean,
): Result<null, AndroidBinaryManifestSplitFailure> => {
  let start = 8;
  while (start + 8 <= declared) {
    const chunk: Chunk = {
      type: reader.u16(start),
      headerSize: reader.u16(start + 2),
      start,
      chunkSize: reader.u32(start + 4),
    };
    if (
      chunk.chunkSize < 8 ||
      chunk.headerSize < 8 ||
      chunk.headerSize > chunk.chunkSize ||
      start + chunk.chunkSize > declared
    )
      return err({
        kind: "malformed",
        message: "A binary XML chunk declares a size outside the document.",
      });
    if (!visit(chunk)) return ok(null);
    start += chunk.chunkSize;
  }
  // A trailing run shorter than a chunk header is a truncated next chunk, not
  // the end of the document: its declarations cannot be read as absent.
  if (start !== declared)
    return err({
      kind: "malformed",
      message: "The binary XML document ends inside a chunk header.",
    });
  return ok(null);
};

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
  headerSize: number,
  chunkSize: number,
): StartElement | null => {
  // A start element begins with the common 16-byte ResXMLNode header, and the
  // attrExt below is read at fixed offsets from it. A chunk that advertises any
  // other header size places the name and attribute table elsewhere, so its
  // declarations can only be read as absent.
  if (headerSize !== RES_XML_NODE_HEADER) return null;
  // The name and the whole attrExt must sit inside this chunk, or the reads
  // below reconstruct a cut-off root from the member's trailing bytes.
  if (RES_XML_NODE_HEADER + RES_XML_ATTR_EXT > chunkSize) return null;
  const attributeStart = reader.u16(start + 24);
  const attributeSize = reader.u16(start + 26);
  const attributeCount = reader.u16(start + 28);
  if (attributeSize < ATTRIBUTE_ROWS) return null;
  // ResXMLTree_attrExt runs 20 bytes from the start of the node; an attribute
  // table starting inside it reads the extension as attribute rows, which would
  // turn a declared value into an absent one.
  if (attributeStart < RES_XML_ATTR_EXT) return null;
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
    // Positions only: a 4 MiB manifest of minimum-size chunks would otherwise
    // retain hundreds of thousands of live objects for a single root lookup.
    let poolChunk: Chunk | undefined;
    let resourceMapChunk: Chunk | undefined;
    const walked = walkChunks(reader, declared, (chunk) => {
      if (poolChunk === undefined && chunk.type === RES_STRING_POOL_TYPE)
        poolChunk = chunk;
      else if (
        resourceMapChunk === undefined &&
        chunk.type === RES_XML_RESOURCE_MAP_TYPE
      )
        resourceMapChunk = chunk;
      return true;
    });
    if (!walked.ok) return walked;
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
    // A resource map is a flat run of 4-byte IDs, so a payload that ends
    // mid-word cannot be rounded down: the ID for an obfuscated or renamed
    // attribute would shift, and a framework attribute would read as absent.
    const resourceIds: number[] = [];
    if (resourceMapChunk !== undefined) {
      if ((resourceMapChunk.chunkSize - resourceMapChunk.headerSize) % 4 !== 0)
        return err({
          kind: "malformed",
          message: "The resource map ends inside a resource ID.",
        });
      for (
        let offset = resourceMapChunk.start + resourceMapChunk.headerSize;
        offset + 4 <= resourceMapChunk.start + resourceMapChunk.chunkSize;
        offset += 4
      )
        resourceIds.push(reader.u32(offset));
    }
    let manifest: StartElement | undefined;
    let application: StartElement | undefined;
    // An unreadable element, or one whose name string is out of range, can
    // still carry the split declarations, so it is remembered and reported as a
    // limitation below instead of reading as an absent declaration.
    let unreadableElement = false;
    // A second readable root or <application> makes the declaration ambiguous:
    // letting the later chunk win would let a duplicate with no attributes
    // erase an earlier `requiredSplitTypes` or `isSplitRequired`, which reads
    // as an absent declaration and leaves JNI coverage looking complete.
    let repeatedElement = false;
    // A bundle-built base APK may declare isSplitRequired on <application>
    // instead of the root, so both elements are retained and read below.
    const scanned = walkChunks(reader, declared, (chunk) => {
      if (chunk.type !== RES_XML_START_ELEMENT_TYPE) return true;
      const element = readStartElement(
        reader,
        strings,
        resourceIds,
        chunk.start,
        chunk.headerSize,
        chunk.chunkSize,
      );
      if (element === null || element.name === null) {
        unreadableElement = true;
        return true;
      }
      if (element.name === "manifest") {
        if (manifest !== undefined) repeatedElement = true;
        manifest = element;
      } else if (element.name === "application") {
        if (application !== undefined) repeatedElement = true;
        application = element;
      }
      return true;
    });
    if (!scanned.ok) return scanned;
    // A root that is present but unreadable still establishes that this is a
    // binary manifest; its declarations are unknown, not absent.
    if (manifest === undefined && !unreadableElement)
      return err({
        kind: "malformed",
        message: "The binary manifest has no <manifest> start element.",
      });
    const androidOf = (element: StartElement) =>
      element.attributes.filter(
        (attribute) => attribute.namespace === ANDROID_NS,
      );
    const manifestAndroid = manifest === undefined ? [] : androidOf(manifest);
    // The root owns the split-type declarations; isSplitRequired falls back to
    // <application>, which is where a bundle-generated base APK carries it.
    const android =
      application === undefined
        ? manifestAndroid
        : [...manifestAndroid, ...androidOf(application)];
    const toValue = (attribute: (typeof android)[number]): string | null =>
      attribute.dataType === TYPE_STRING
        ? (strings[attribute.data] ?? null)
        : attribute.raw;
    // A canonical resource ID identifies the framework attribute whether or not
    // its namespace and name strings survived; only the spelling fallback needs
    // them, so it stays restricted to the Android namespace.
    const all = [
      ...(manifest?.attributes ?? []),
      ...(application?.attributes ?? []),
    ];
    // A duplicate declaration leaves no single value authoritative, so the
    // caller treats the field as ambiguous rather than trusting the first row.
    // The framework ID wins over spelling, and an attribute the ID names inside
    // the Android namespace wins over one it names outside it, so the duplicate
    // count covers exactly the declarations the value came from.
    const find = (resourceId: number, name: string) => {
      const identified = all.filter(
        (attribute) => attribute.resourceId === resourceId,
      );
      const androidIdentified = identified.filter(
        (attribute) => attribute.namespace === ANDROID_NS,
      );
      const matches =
        identified.length > 0
          ? androidIdentified.length > 0
            ? androidIdentified
            : identified
          : all.filter(
              (attribute) =>
                attribute.namespace === ANDROID_NS && attribute.name === name,
            );
      return { attribute: matches[0], duplicate: matches.length > 1 };
    };
    const requiredSplitTypes = find(
      REQUIRED_SPLIT_TYPES_ID,
      "requiredSplitTypes",
    );
    const splitName = find(SPLIT_NAME_ID, "splitName");
    const requiredFlag = find(IS_SPLIT_REQUIRED_ID, "isSplitRequired");
    // A resource reference carries no literal to read, so a declaration that is
    // present but not literal stays unknown rather than reading as absent: the
    // reference can resolve to true at install time. A repeated root or
    // <application> is unknown for the same reason: no single element is
    // authoritative, so neither an absent nor a false reading is established.
    // A field declared more than once is ambiguous for the same reason a
    // repeated root is: no single row establishes the value the installer sees.
    const elementsAmbiguous = unreadableElement || repeatedElement;
    const flagAmbiguous = elementsAmbiguous || requiredFlag.duplicate;
    const typesAmbiguous = elementsAmbiguous || requiredSplitTypes.duplicate;
    const requiredFlagAttribute = requiredFlag.attribute;
    const isSplitRequired: boolean | "unknown" | null =
      requiredFlagAttribute === undefined
        ? flagAmbiguous
          ? "unknown"
          : null
        : requiredFlagAttribute.dataType === TYPE_INT_BOOLEAN
          ? flagAmbiguous
            ? "unknown"
            : requiredFlagAttribute.data !== 0
          : requiredFlagAttribute.dataType === TYPE_STRING
            ? flagAmbiguous
              ? "unknown"
              : (strings[requiredFlagAttribute.data] ?? null) === "true"
                ? true
                : (strings[requiredFlagAttribute.data] ?? null) === "false"
                  ? false
                  : "unknown"
            : "unknown";
    const requiredSplitTypesAttribute = requiredSplitTypes.attribute;
    const requiredValue =
      requiredSplitTypesAttribute === undefined
        ? null
        : toValue(requiredSplitTypesAttribute);
    const requiredTypes =
      requiredValue === null
        ? requiredSplitTypesAttribute === undefined
          ? null
          : "unknown"
        : typesAmbiguous
          ? "unknown"
          : splitTypes(requiredValue);
    return ok({
      // An unreadable element can carry either declaration, and the roots that
      // remain readable do not establish that they are absent.
      required_split_types:
        requiredTypes === null && elementsAmbiguous ? "unknown" : requiredTypes,
      split_name:
        splitName.attribute === undefined ? null : toValue(splitName.attribute),
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
