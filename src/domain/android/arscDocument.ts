import { err, ok, type Result } from "../result.js";
import { BinaryReader } from "../binaryContainer.js";
import { Budget } from "../budget.js";
import { byteToHex } from "../../kernel/byteToHex.js";
import {
  ARSC_CHUNK_HEADER_BYTES,
  ARSC_CHUNK_TYPE,
  ARSC_HEADER_BYTES,
} from "../arscFormat.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";
import {
  escapeAttr,
  escapedAttrByteLength,
  escapeXml,
  FORBIDDEN_XML,
  hexRef,
  renderTypedValue,
  StringPool,
  type ChunkHeader,
} from "./axmlDocument.js";

/**
 * Android compiled resource table decoder: parses the ResTable chunk stream
 * (global string pool, packages, type specs and typed entries) and renders a
 * deterministic XML projection naming every entry by its key. Values come
 * only from declared data; string values resolve through the table's own
 * global string pool and unresolved references stay numeric.
 */
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_PACKAGE = 0x0200;
const CHUNK_TYPE_SPEC = 0x0202;
const CHUNK_TYPE = 0x0201;
// Defined AOSP package members we deliberately do not project yet.
const CHUNK_LIBRARY = 0x0203;
const CHUNK_OVERLAYABLE = 0x0204;
const CHUNK_OVERLAYABLE_POLICY = 0x0205;
const CHUNK_STAGED_ALIAS = 0x0206;

const ENTRY_COMPLEX = 0x0001;
const SPEC_PUBLIC = 0x40000000;
const NO_ENTRY = 0xffffffff;

const RES_VALUE_BYTES = 8;
/** ResTable_package headers before the Android O typeIdOffset tail field. */
const PACKAGE_HEADER_MIN_BYTES = 284;
const PACKAGE_HEADER_ID_OFFSET_BYTES = 288;
const TYPE_SPEC_HEADER_BYTES = 16;
const TYPE_HEADER_MIN_BYTES = 24;

const TYPE_FLAG_SPARSE = 0x01;
const TYPE_FLAG_OFFSET16 = 0x02;
const TYPE_FLAG_COMPACT = 0x08;

const ARSC_MAX_FILE_BYTES = 64 * 1024 * 1024;
const ARSC_MAX_PACKAGES = 256;
const ARSC_MAX_STRINGS = 0x100000;
const ARSC_MAX_STRING_BYTES = 64 * 1024 * 1024;
const ARSC_MAX_ENTRIES = 0x100000;
const ARSC_MAX_OUTPUT_BYTES = 96 * 1024 * 1024;

export interface ArscDocumentImage {
  readonly metadata: {
    readonly package_count: number;
    readonly type_count: number;
    readonly entry_count: number;
    readonly string_count: number;
    readonly declared_size: number;
  };
  /** The deterministic decoded XML text as UTF-8 bytes. */
  readonly xml: Uint8Array;
  /** Every declared chunk was walked to the declared document size. */
  readonly terminated: boolean;
  readonly limitations: readonly string[];
}

const formatFailure = (message: string): Result<never, RegionDecodeFailure> =>
  err({ kind: "malformed", message });

const limitFailure = (message: string): Result<never, RegionDecodeFailure> =>
  err({ kind: "limit", message, boundary: "capacity" });

/**
 * Package name lives in a fixed 128-slot UTF-16 array terminated by NUL.
 * Unpaired surrogates fail decoding instead of leaking U+FFFD into XML.
 */
const readPackageName = (
  reader: BinaryReader,
  base: number,
): string | undefined => {
  const units: number[] = [];
  for (let i = 0; i < 128; i++) {
    const unit = reader.u16(base + 12 + i * 2);
    if (unit === 0) break;
    units.push(unit);
  }
  try {
    return new TextDecoder("utf-16le", {
      ignoreBOM: true,
      fatal: true,
    }).decode(new Uint16Array(units).buffer as ArrayBuffer);
  } catch {
    return undefined;
  }
};

/**
 * Packed 5-bit letter/digit triplets used by AOSP ResTable_config: the first
 * character sits in the lowest five bits and each character is `base`-offset
 * ('a' for language letters, '0' for region digits).
 */
const unpackLocale = (packed: number, base: number): string =>
  String.fromCharCode(
    base + (packed & 0x1f),
    base + ((packed >> 5) & 0x1f),
    base + ((packed >> 10) & 0x1f),
  );

const readLocaleField = (
  hi: number,
  lo: number,
  packedBase: number,
): string | undefined => {
  if (hi === 0 && lo === 0) return undefined;
  if ((hi & 0x80) !== 0) return unpackLocale((hi << 8) | lo, packedBase);
  return String.fromCharCode(hi, lo);
};

const ORIENTATIONS = ["", "port", "land", "square"] as const;
const SCREEN_LAYOUT_SIZES = ["", "small", "normal", "large", "xlarge"] as const;
const UI_MODES = [
  "",
  "",
  "",
  "",
  "",
  "car",
  "desk",
  "television",
  "appliance",
  "watch",
  "",
  "",
  "",
  "",
  "",
  "vrheadset",
] as const;
const TOUCHSCREENS = ["", "", "", "notouch", "finger"] as const;
const KEYBOARDS = ["", "keysexposed", "keyshidden", "keyssoft"] as const;
const NAVIGATIONS = [
  "",
  "",
  "",
  "",
  "nonav",
  "dpad",
  "trackball",
  "wheel",
] as const;

const lookup = (table: readonly string[], index: number): string =>
  table[index] ?? `unknown${index}`;

/**
 * Render the ResTable_config qualifier suffix for a type chunk. Only fields
 * inside the declared config size are read. Undecoded encodings and fields
 * that live past the layout we interpret stay explicit instead of collapsing
 * into `default`.
 */
const renderConfig = (
  reader: BinaryReader,
  base: number,
  size: number,
): string => {
  const parts: string[] = [];
  if (size >= 8) {
    const mcc = reader.u16(base + 4);
    const mnc = reader.u16(base + 6);
    if (mcc !== 0) parts.push(`mcc${mcc}`);
    if (mnc !== 0) parts.push(`mnc${mnc}`);
  }
  if (size >= 12) {
    const language = readLocaleField(
      reader.bytes[base + 8]!,
      reader.bytes[base + 9]!,
      0x61,
    );
    const region = readLocaleField(
      reader.bytes[base + 10]!,
      reader.bytes[base + 11]!,
      0x30,
    );
    if (language !== undefined)
      parts.push(region === undefined ? language : `${language}-r${region}`);
    else if (region !== undefined) parts.push(`r${region}`);
  }
  if (size >= 16) {
    const orientation = reader.bytes[base + 12]!;
    const touchscreen = reader.bytes[base + 13]!;
    const density = reader.u16(base + 14);
    if (orientation !== 0) parts.push(lookup(ORIENTATIONS, orientation));
    if (touchscreen !== 0) parts.push(lookup(TOUCHSCREENS, touchscreen));
    if (density === 0xffff) parts.push("nodpi");
    else if (density !== 0) parts.push(`${density}dpi`);
  }
  if (size >= 20) {
    const keyboard = reader.bytes[base + 16]!;
    const navigation = reader.bytes[base + 17]!;
    if (keyboard !== 0) parts.push(lookup(KEYBOARDS, keyboard));
    if (navigation !== 0) parts.push(lookup(NAVIGATIONS, navigation));
  }
  if (size >= 24) {
    const width = reader.u16(base + 20);
    const height = reader.u16(base + 22);
    if (width !== 0) parts.push(`w${width}dp`);
    if (height !== 0) parts.push(`h${height}dp`);
  }
  if (size >= 28) {
    const sdk = reader.u16(base + 24);
    const minor = reader.u16(base + 26);
    if (sdk !== 0) parts.push(minor !== 0 ? `v${sdk}.${minor}` : `v${sdk}`);
  }
  if (size >= 32) {
    const layout = reader.bytes[base + 28]!;
    const uiMode = reader.bytes[base + 29]!;
    const smallestWidth = reader.u16(base + 30);
    if ((layout & 0x0f) !== 0)
      parts.push(lookup(SCREEN_LAYOUT_SIZES, layout & 0x0f));
    if ((layout & 0xc0) === 0x40) parts.push("long");
    else if ((layout & 0xc0) === 0x80) parts.push("notlong");
    if ((uiMode & 0x20) !== 0) parts.push("night");
    if ((uiMode & 0x0f) !== 0) parts.push(lookup(UI_MODES, uiMode & 0x0f));
    if (smallestWidth !== 0) parts.push(`sw${smallestWidth}dp`);
  }
  // Fields past the interpreted layout are reported instead of silently
  // folded into a default-looking label.
  if (size > 36) parts.push(`fields${size}`);
  return parts.length === 0 ? "default" : parts.join("-");
};

class BufferedArscDecoder implements RegionDecoder<ArscDocumentImage> {
  #chunks: Uint8Array[] = [];
  #inputBudget = new Budget(ARSC_MAX_FILE_BYTES);

  constructor(private readonly fileBytes: number) {}

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (!this.#inputBudget.tryCharge(chunk.length))
      return err({
        kind: "limit",
        message: `arsc input exceeds the ${ARSC_MAX_FILE_BYTES}-byte bound`,
        boundary: "capacity",
      });
    this.#chunks.push(chunk.slice());
    return ok(undefined);
  }

  finish(): Result<ArscDocumentImage, RegionDecodeFailure> {
    const bytes = new Uint8Array(this.#inputBudget.used);
    let at = 0;
    for (const part of this.#chunks) {
      bytes.set(part, at);
      at += part.length;
    }
    this.#chunks = [];
    if (bytes.length < ARSC_HEADER_BYTES)
      return formatFailure("arsc table is shorter than the 12-byte header");
    const reader = new BinaryReader(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length),
      true,
      "arsc",
    );
    if (reader.u16(0) !== ARSC_CHUNK_TYPE)
      return formatFailure("missing RES_TABLE_TYPE header");
    const headerSize = reader.u16(2);
    if (headerSize < ARSC_HEADER_BYTES)
      return formatFailure(
        `table header ${headerSize} is below the fixed 12 bytes`,
      );
    const declaredSize = reader.u32(4);
    const declaredPackages = reader.u32(8);
    if (declaredSize < headerSize)
      return formatFailure(
        `declared size ${declaredSize} is below the table header`,
      );
    if (declaredPackages > ARSC_MAX_PACKAGES)
      return limitFailure(
        `table declares ${declaredPackages} packages above the ${ARSC_MAX_PACKAGES} bound`,
      );
    const limitations: string[] = [];
    let documentEnd = declaredSize;
    if (declaredSize > bytes.length) {
      limitations.push(
        `table declares ${declaredSize} bytes; only ${bytes.length} were admitted`,
      );
      documentEnd = bytes.length;
    }

    const readChunk = (
      at: number,
      end: number,
    ): Result<ChunkHeader, RegionDecodeFailure> => {
      if (at + ARSC_CHUNK_HEADER_BYTES > end)
        return formatFailure(`chunk header at ${at} is truncated`);
      const type = reader.u16(at);
      const chunkHeaderSize = reader.u16(at + 2);
      const size = reader.u32(at + 4);
      if (chunkHeaderSize < ARSC_CHUNK_HEADER_BYTES || size < chunkHeaderSize)
        return formatFailure(
          `chunk 0x${type.toString(16)} at ${at} has impossible header ${chunkHeaderSize}/size ${size}`,
        );
      if (at + size > end)
        return formatFailure(
          `chunk 0x${type.toString(16)} at ${at} extends past its enclosing extent`,
        );
      return ok({ type, headerSize: chunkHeaderSize, size });
    };

    const out: Uint8Array[] = [];
    const outputBudget = new Budget(ARSC_MAX_OUTPUT_BYTES);
    const encoder = new TextEncoder();
    const emit = (text: string): boolean => {
      const encoded = encoder.encode(text);
      if (!outputBudget.tryCharge(encoded.length)) return false;
      out.push(encoded);
      return true;
    };
    const emitOrLimit = (
      text: string,
    ): Result<never, RegionDecodeFailure> | undefined =>
      emit(text)
        ? undefined
        : limitFailure(
            `projected output exceeds the ${ARSC_MAX_OUTPUT_BYTES}-byte bound`,
          );
    /**
     * Emit a line assembled from static fragments and escaped attribute
     * values, charging the exact encoded size before materializing it.
     * Static fragments are ASCII-only by construction.
     */
    const emitXml = (
      parts: readonly (string | { attr: string })[],
    ): Result<never, RegionDecodeFailure> | undefined => {
      let bytes = 0;
      for (const part of parts)
        bytes +=
          typeof part === "string"
            ? part.length
            : escapedAttrByteLength(part.attr);
      if (!outputBudget.tryCharge(bytes))
        return limitFailure(
          `projected output exceeds the ${ARSC_MAX_OUTPUT_BYTES}-byte bound`,
        );
      let text = "";
      for (const part of parts)
        text += typeof part === "string" ? part : escapeAttr(part.attr);
      out.push(encoder.encode(text));
      return undefined;
    };

    let packageCount = 0;
    let typeCount = 0;
    let entryCount = 0;
    let skippedChunks = 0;
    let unrenderedValues = 0;
    let globalPool: StringPool | undefined;

    /** Walk a type chunk's entries inside [base, base+size). */
    const emitType = (
      base: number,
      header: ChunkHeader,
      typeStrings: StringPool,
      keyStrings: StringPool,
      packageId: number,
      typeIdOffset: number,
      specFlags: readonly number[] | undefined,
    ): Result<never, RegionDecodeFailure> | undefined => {
      if (header.headerSize < TYPE_HEADER_MIN_BYTES)
        return formatFailure(
          `type chunk header ${header.headerSize} is below the fixed 24 bytes`,
        );
      const typeId = reader.bytes[base + 8]!;
      const flags = reader.bytes[base + 9]!;
      const count = reader.u32(base + 12);
      const entriesStart = reader.u32(base + 16);
      const configSize = reader.u32(base + 20);
      if (configSize < 4 || 20 + configSize > header.headerSize)
        return formatFailure(
          `type config ${configSize} exceeds the chunk header ${header.headerSize}`,
        );
      const sparse = (flags & TYPE_FLAG_SPARSE) !== 0;
      const offset16 = (flags & TYPE_FLAG_OFFSET16) !== 0;
      const compact = (flags & TYPE_FLAG_COMPACT) !== 0;
      if (sparse && offset16)
        return formatFailure(
          `type ${typeId} combines the sparse and offset16 layouts`,
        );
      if (sparse && compact)
        return formatFailure(
          `type ${typeId} combines the sparse and compact layouts`,
        );
      if (entriesStart < header.headerSize || entriesStart > header.size)
        return formatFailure(
          `type entries start ${entriesStart} lies outside the chunk`,
        );
      const slotBytes = offset16 ? 2 : 4;
      if (base + header.headerSize + count * slotBytes > base + header.size)
        return formatFailure(
          `type ${typeId} declares ${count} entry offsets past the chunk end`,
        );
      if (count > ARSC_MAX_ENTRIES)
        return limitFailure(
          `type ${typeId} declares ${count} entries above the ${ARSC_MAX_ENTRIES} bound`,
        );
      const typeName = typeStrings.get(typeId - 1);
      if (typeName === undefined || typeName === null)
        return formatFailure(
          `type ${typeId} has no name in the package type pool`,
        );
      const config = renderConfig(reader, base + 20, configSize);
      const failing = emitXml([
        `    <type id="${hexRef(typeId + typeIdOffset)}" name="`,
        { attr: typeName },
        `" config="`,
        { attr: config },
        `">\n`,
      ]);
      if (failing !== undefined) return failing;
      const entriesBase = base + entriesStart;
      // Sparse slots pair a u16 entry index with a u16 offset in 4-byte
      // units; offset16 slots are plain u16 offsets in 4-byte units.
      const slotAt = (i: number): { index: number; rel: number } => {
        const at = base + header.headerSize + i * slotBytes;
        if (sparse) {
          const slot = reader.u32(at);
          return { index: slot >>> 16, rel: (slot & 0xffff) * 4 };
        }
        if (offset16) {
          const slot = reader.u16(at);
          return {
            index: i,
            rel: slot === 0xffff ? NO_ENTRY : slot * 4,
          };
        }
        return { index: i, rel: reader.u32(at) };
      };
      for (let i = 0; i < count; i++) {
        const { index, rel } = slotAt(i);
        if (rel === NO_ENTRY) continue;
        const entryBase = entriesBase + rel;
        if (compact) {
          // Compact entries are fixed 8-byte records: the upper byte of the
          // flag field carries the data type and no Res_value follows.
          if (rel + 8 > header.size - entriesStart)
            return formatFailure(
              `compact entry ${index} of type ${typeId} lies outside the entry block`,
            );
          const keyIndex = reader.u16(entryBase);
          const valueType = reader.bytes[entryBase + 3]!;
          const valueData = reader.u32(entryBase + 4);
          const name = keyStrings.get(keyIndex);
          if (name === undefined || name === null)
            return formatFailure(
              `entry ${index} of type ${typeId} has no key in the package key pool`,
            );
          const id =
            (packageId << 24) | ((typeId + typeIdOffset) << 16) | index;
          const rendered = globalPool
            ? renderTypedValue(valueType, valueData, globalPool)
            : undefined;
          const parts: (string | { attr: string })[] = [
            `      <entry id="${hexRef(id)}" name="`,
            { attr: name },
            '"',
          ];
          if ((specFlags?.[index] ?? 0) & SPEC_PUBLIC)
            parts.push(' public="true"');
          if (rendered === undefined) {
            unrenderedValues += 1;
            parts.push(
              ` value="${hexRef(valueData)}"`,
              ` type="0x${byteToHex(valueType)}"`,
            );
          } else {
            parts.push(' value="', { attr: rendered }, '"');
          }
          parts.push("/>\n");
          entryCount += 1;
          if (entryCount > ARSC_MAX_ENTRIES)
            return limitFailure(
              `table projects more than the ${ARSC_MAX_ENTRIES}-entry bound`,
            );
          const inner = emitXml(parts);
          if (inner !== undefined) return inner;
          continue;
        }
        if (rel + 8 > header.size - entriesStart)
          return formatFailure(
            `entry ${index} of type ${typeId} lies outside the entry block`,
          );
        const entrySize = reader.u16(entryBase);
        if (entryBase + entrySize > base + header.size)
          return formatFailure(
            `entry ${index} of type ${typeId} extends past the chunk end`,
          );
        const entryFlags = reader.u16(entryBase + 2);
        const keyIndex = reader.u32(entryBase + 4);
        if (entrySize < RES_VALUE_BYTES)
          return formatFailure(
            `entry ${index} of type ${typeId} is shorter than 8 bytes`,
          );
        const name = keyStrings.get(keyIndex);
        if (name === undefined || name === null)
          return formatFailure(
            `entry ${index} of type ${typeId} has no key in the package key pool`,
          );
        const id = (packageId << 24) | ((typeId + typeIdOffset) << 16) | index;
        const parts: (string | { attr: string })[] = [
          `      <entry id="${hexRef(id)}" name="`,
          { attr: name },
          '"',
        ];
        if ((specFlags?.[index] ?? 0) & SPEC_PUBLIC)
          parts.push(' public="true"');
        entryCount += 1;
        if (entryCount > ARSC_MAX_ENTRIES)
          return limitFailure(
            `table projects more than the ${ARSC_MAX_ENTRIES}-entry bound`,
          );
        if ((entryFlags & ENTRY_COMPLEX) === 0) {
          // The Res_value record sits after the variable-size entry header.
          const valueAt = entryBase + entrySize;
          if (valueAt + RES_VALUE_BYTES > base + header.size)
            return formatFailure(
              `entry ${index} of type ${typeId} carries a truncated value`,
            );
          if (
            reader.u16(valueAt) !== RES_VALUE_BYTES ||
            reader.bytes[valueAt + 2] !== 0
          )
            return formatFailure(
              `entry ${index} of type ${typeId} carries an invalid Res_value header`,
            );
          const valueType = reader.bytes[valueAt + 3]!;
          const valueData = reader.u32(valueAt + 4);
          const rendered = globalPool
            ? renderTypedValue(valueType, valueData, globalPool)
            : undefined;
          if (rendered === undefined) {
            unrenderedValues += 1;
            parts.push(
              ` value="${hexRef(valueData)}"`,
              ` type="0x${byteToHex(valueType)}"`,
            );
          } else {
            parts.push(' value="', { attr: rendered }, '"');
          }
          parts.push("/>\n");
          const inner = emitXml(parts);
          if (inner !== undefined) return inner;
          continue;
        }
        if (entrySize < 16)
          return formatFailure(
            `complex entry ${index} of type ${typeId} lacks the map header`,
          );
        const parent = reader.u32(entryBase + 8);
        const mapCount = reader.u32(entryBase + 12);
        if (entryBase + entrySize + mapCount * 12 > base + header.size)
          return formatFailure(
            `complex entry ${index} of type ${typeId} declares ${mapCount} items past the chunk end`,
          );
        if (parent !== 0) parts.push(` parent="${hexRef(parent)}"`);
        parts.push(">\n");
        const open = emitXml(parts);
        if (open !== undefined) return open;
        for (let m = 0; m < mapCount; m++) {
          const mapBase = entryBase + entrySize + m * 12;
          const mapName = reader.u32(mapBase);
          const valueType = reader.bytes[mapBase + 7]!;
          const valueData = reader.u32(mapBase + 8);
          const rendered = globalPool
            ? renderTypedValue(valueType, valueData, globalPool)
            : undefined;
          const itemParts: (string | { attr: string })[] = [
            `        <item name="@${hexRef(mapName)}"`,
          ];
          if (rendered === undefined) {
            unrenderedValues += 1;
            itemParts.push(
              ` value="${hexRef(valueData)}"`,
              ` type="0x${byteToHex(valueType)}"`,
            );
          } else {
            itemParts.push(' value="', { attr: rendered }, '"');
          }
          itemParts.push("/>\n");
          const item = emitXml(itemParts);
          if (item !== undefined) return item;
        }
        const close = emitOrLimit("      </entry>\n");
        if (close !== undefined) return close;
      }
      return emitOrLimit("    </type>\n");
    };

    // The table is a global string pool followed by package chunks.
    if (!emit("<resources>\n"))
      return limitFailure(
        `projected output exceeds the ${ARSC_MAX_OUTPUT_BYTES}-byte bound`,
      );
    let cursor = headerSize;
    while (cursor < documentEnd) {
      const header = readChunk(cursor, documentEnd);
      if (!header.ok) return header;
      const h = header.value;
      if (h.type === CHUNK_STRING_POOL) {
        if (globalPool !== undefined || packageCount > 0)
          return formatFailure(
            `unexpected string pool at ${cursor} inside the table body`,
          );
        const pool = StringPool.parse(reader, cursor, h, documentEnd, {
          maxStrings: ARSC_MAX_STRINGS,
          maxStringBytes: ARSC_MAX_STRING_BYTES,
          requireXmlChars: true,
        });
        if (!pool.ok) return pool;
        globalPool = pool.value;
      } else if (h.type === CHUNK_PACKAGE) {
        if (h.headerSize < PACKAGE_HEADER_MIN_BYTES)
          return formatFailure(
            `package header ${h.headerSize} is below the fixed ${PACKAGE_HEADER_MIN_BYTES} bytes`,
          );
        if (globalPool === undefined)
          return formatFailure("a package precedes the global string pool");
        const packageName = readPackageName(reader, cursor);
        if (packageName === undefined || FORBIDDEN_XML.test(packageName))
          return formatFailure(
            "package name contains characters XML cannot represent",
          );
        const packageEmitted = emitXml([
          `  <package id="${hexRef(reader.u32(cursor + 8))}" name="`,
          { attr: packageName },
          `">\n`,
        ]);
        if (packageEmitted !== undefined) return packageEmitted;
        const packageEnd = cursor + h.size;
        const typeStringsAt = reader.u32(cursor + 268);
        const keyStringsAt = reader.u32(cursor + 276);
        const typeIdOffset =
          h.headerSize >= PACKAGE_HEADER_ID_OFFSET_BYTES
            ? reader.u32(cursor + 284)
            : 0;
        const packageId = reader.u32(cursor + 8);
        if (packageId > 0xff)
          return formatFailure(
            `package id ${packageId} exceeds the one-byte id space`,
          );
        // The two pools lead the package body at their declared offsets.
        const typePoolHeader = readChunk(cursor + typeStringsAt, packageEnd);
        if (!typePoolHeader.ok) return typePoolHeader;
        const keyPoolHeader = readChunk(cursor + keyStringsAt, packageEnd);
        if (!keyPoolHeader.ok) return keyPoolHeader;
        if (
          typePoolHeader.value.type !== CHUNK_STRING_POOL ||
          keyPoolHeader.value.type !== CHUNK_STRING_POOL
        )
          return formatFailure(
            "package type/key string offsets do not lead to string pools",
          );
        const typeStrings = StringPool.parse(
          reader,
          cursor + typeStringsAt,
          typePoolHeader.value,
          packageEnd,
          {
            maxStrings: ARSC_MAX_STRINGS,
            maxStringBytes: ARSC_MAX_STRING_BYTES,
            requireXmlChars: true,
          },
        );
        if (!typeStrings.ok) return typeStrings;
        const keyStrings = StringPool.parse(
          reader,
          cursor + keyStringsAt,
          keyPoolHeader.value,
          packageEnd,
          {
            maxStrings: ARSC_MAX_STRINGS,
            maxStringBytes: ARSC_MAX_STRING_BYTES,
            requireXmlChars: true,
          },
        );
        if (!keyStrings.ok) return keyStrings;
        // Walk the remaining package body after the larger pool offset.
        let inner = cursor + Math.max(typeStringsAt, keyStringsAt);
        const last =
          inner === cursor + typeStringsAt ? typePoolHeader : keyPoolHeader;
        inner += last.value.size;
        const specs = new Map<number, readonly number[]>();
        while (inner < packageEnd) {
          const sub = readChunk(inner, packageEnd);
          if (!sub.ok) return sub;
          const s = sub.value;
          if (s.type === CHUNK_TYPE_SPEC) {
            if (s.headerSize < TYPE_SPEC_HEADER_BYTES)
              return formatFailure(
                `type spec header ${s.headerSize} is below the fixed ${TYPE_SPEC_HEADER_BYTES} bytes`,
              );
            const specId = reader.bytes[inner + 8]!;
            const specCount = reader.u32(inner + 12);
            if (specCount > ARSC_MAX_ENTRIES)
              return limitFailure(
                `type spec ${specId} declares ${specCount} flags above the ${ARSC_MAX_ENTRIES} bound`,
              );
            if (s.headerSize + specCount * 4 > s.size)
              return formatFailure(
                `type spec ${specId} declares ${specCount} flags past the chunk end`,
              );
            const flags: number[] = new Array(specCount);
            for (let i = 0; i < specCount; i++)
              flags[i] = reader.u32(inner + s.headerSize + i * 4);
            specs.set(specId, flags);
          } else if (s.type === CHUNK_TYPE) {
            const emitted = emitType(
              inner,
              s,
              typeStrings.value,
              keyStrings.value,
              packageId,
              typeIdOffset,
              specs.get(reader.bytes[inner + 8]!),
            );
            if (emitted !== undefined) return emitted;
            typeCount += 1;
          } else if (
            s.type === CHUNK_LIBRARY ||
            s.type === CHUNK_OVERLAYABLE ||
            s.type === CHUNK_OVERLAYABLE_POLICY ||
            s.type === CHUNK_STAGED_ALIAS
          ) {
            skippedChunks += 1;
          } else {
            return formatFailure(
              `unexpected chunk 0x${s.type.toString(16)} at ${inner} inside the package`,
            );
          }
          inner += s.size;
        }
        const closePackage = emitOrLimit("  </package>\n");
        if (closePackage !== undefined) return closePackage;
        packageCount += 1;
        if (packageCount > ARSC_MAX_PACKAGES)
          return limitFailure(
            `table walks more than the ${ARSC_MAX_PACKAGES}-package bound`,
          );
      } else {
        return formatFailure(
          `unexpected chunk 0x${h.type.toString(16)} at ${cursor} in the table`,
        );
      }
      cursor += h.size;
    }
    if (globalPool === undefined)
      return formatFailure("the table declares no global string pool");
    if (packageCount === 0)
      return formatFailure("the table declares no packages");
    if (packageCount !== declaredPackages)
      limitations.push(
        `table declares ${declaredPackages} packages; ${packageCount} were walked`,
      );
    if (documentEnd < bytes.length)
      limitations.push(
        `${bytes.length - documentEnd} trailing bytes past the declared table size were not examined`,
      );
    if (skippedChunks !== 0)
      limitations.push(
        `${skippedChunks} library/overlay/staged-alias chunks were walked but not projected`,
      );
    if (unrenderedValues !== 0)
      limitations.push(
        `${unrenderedValues} values carried an unrenderable type or a missing global string`,
      );

    if (!emit("</resources>\n"))
      return limitFailure(
        `projected output exceeds the ${ARSC_MAX_OUTPUT_BYTES}-byte bound`,
      );
    const xml = new Uint8Array(outputBudget.used);
    let offset = 0;
    for (const part of out) {
      xml.set(part, offset);
      offset += part.length;
    }
    return ok({
      metadata: {
        package_count: packageCount,
        type_count: typeCount,
        entry_count: entryCount,
        string_count: globalPool.count,
        declared_size: declaredSize,
      },
      xml,
      terminated: cursor === documentEnd && documentEnd === declaredSize,
      limitations,
    });
  }
}

/**
 * Create a bounded buffered decoder for an admitted ResTable carrier. The
 * decoder accumulates bytes up to the file bound and parses on finish.
 */
export const createArscDecoder = (
  fileBytes: number,
): Result<RegionDecoder<ArscDocumentImage>, RegionDecodeFailure> => {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0)
    return err({ kind: "malformed", message: "invalid file size" });
  if (fileBytes > ARSC_MAX_FILE_BYTES)
    return err({
      kind: "limit",
      message: `arsc file ${fileBytes} exceeds the ${ARSC_MAX_FILE_BYTES}-byte bound`,
      boundary: "file-size",
    });
  return ok(new BufferedArscDecoder(fileBytes));
};
