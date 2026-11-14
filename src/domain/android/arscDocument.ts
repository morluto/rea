import { err, ok, type Result } from "../result.js";
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
  escapeXml,
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
const PACKAGE_HEADER_BYTES = 288;
const TYPE_SPEC_HEADER_BYTES = 16;
const TYPE_HEADER_MIN_BYTES = 24;

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
  err({ kind: "format", message });

const limitFailure = (message: string): Result<never, RegionDecodeFailure> =>
  err({ kind: "limit", message, boundary: "capacity" });

/** Package name lives in a fixed 128-slot UTF-16 array terminated by NUL. */
const readPackageName = (view: DataView, base: number): string => {
  const units: number[] = [];
  for (let i = 0; i < 128; i++) {
    const unit = view.getUint16(base + 12 + i * 2, true);
    if (unit === 0) break;
    units.push(unit);
  }
  return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(
    new Uint16Array(units).buffer as ArrayBuffer,
  );
};

/** Base-3 packed locale letter triplet used by AOSP ResTable_config. */
const unpackLanguage = (packed: number): string =>
  String.fromCharCode(
    0x61 + ((packed >> 7) & 0x1f) - 1,
    0x61 + ((packed >> 2) & 0x1f) - 1,
    0x61 + (packed & 0x3) - 1,
  );

const readLocaleField = (hi: number, lo: number): string | undefined => {
  if (hi === 0 && lo === 0) return undefined;
  if ((hi & 0x80) !== 0) return unpackLanguage((hi << 8) | lo);
  return String.fromCharCode(hi, lo);
};

/**
 * Render the ResTable_config qualifier suffix for a type chunk. Only fields
 * inside the declared config size are read; unknown encodings are omitted.
 */
const renderConfig = (view: DataView, base: number, size: number): string => {
  const parts: string[] = [];
  if (size >= 8) {
    const mcc = view.getUint16(base + 4, true);
    const mnc = view.getUint16(base + 6, true);
    if (mcc !== 0) parts.push(`mcc${mcc}`);
    if (mnc !== 0) parts.push(`mnc${mnc}`);
  }
  if (size >= 12) {
    const language = readLocaleField(
      view.getUint8(base + 8),
      view.getUint8(base + 9),
    );
    const region = readLocaleField(
      view.getUint8(base + 10),
      view.getUint8(base + 11),
    );
    if (language !== undefined)
      parts.push(region === undefined ? language : `${language}-r${region}`);
  }
  if (size >= 16) {
    const density = view.getUint16(base + 14, true);
    if (density !== 0 && density !== 0xffff) parts.push(`${density}dpi`);
    if (density === 0xffff) parts.push("nodpi");
  }
  if (size >= 24) {
    const width = view.getUint16(base + 20, true);
    const height = view.getUint16(base + 22, true);
    if (width !== 0) parts.push(`w${width}dp`);
    if (height !== 0) parts.push(`h${height}dp`);
  }
  if (size >= 28) {
    const sdk = view.getUint16(base + 24, true);
    if (sdk !== 0) parts.push(`v${sdk}`);
  }
  return parts.length === 0 ? "default" : parts.join("-");
};

class BufferedArscDecoder implements RegionDecoder<ArscDocumentImage> {
  #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(private readonly fileBytes: number) {}

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (this.#length + chunk.length > ARSC_MAX_FILE_BYTES)
      return err({
        kind: "limit",
        message: `arsc input exceeds the ${ARSC_MAX_FILE_BYTES}-byte bound`,
        boundary: "capacity",
      });
    this.#chunks.push(chunk.slice());
    this.#length += chunk.length;
    return ok(undefined);
  }

  finish(): Result<ArscDocumentImage, RegionDecodeFailure> {
    const bytes = new Uint8Array(this.#length);
    let at = 0;
    for (const part of this.#chunks) {
      bytes.set(part, at);
      at += part.length;
    }
    this.#chunks = [];
    if (bytes.length < ARSC_HEADER_BYTES)
      return formatFailure("arsc table is shorter than the 12-byte header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (view.getUint16(0, true) !== ARSC_CHUNK_TYPE)
      return formatFailure("missing RES_TABLE_TYPE header");
    const headerSize = view.getUint16(2, true);
    if (headerSize < ARSC_HEADER_BYTES)
      return formatFailure(
        `table header ${headerSize} is below the fixed 12 bytes`,
      );
    const declaredSize = view.getUint32(4, true);
    const declaredPackages = view.getUint32(8, true);
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
      const type = view.getUint16(at, true);
      const chunkHeaderSize = view.getUint16(at + 2, true);
      const size = view.getUint32(at + 4, true);
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
    let outBytes = 0;
    const encoder = new TextEncoder();
    const emit = (text: string): boolean => {
      const encoded = encoder.encode(text);
      if (outBytes + encoded.length > ARSC_MAX_OUTPUT_BYTES) return false;
      out.push(encoded);
      outBytes += encoded.length;
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
      const typeId = view.getUint8(base + 8);
      const count = view.getUint32(base + 12, true);
      const entriesStart = view.getUint32(base + 16, true);
      const configSize = view.getUint32(base + 20, true);
      if (configSize < 4 || 20 + configSize > header.headerSize)
        return formatFailure(
          `type config ${configSize} exceeds the chunk header ${header.headerSize}`,
        );
      if (entriesStart < header.headerSize || entriesStart > header.size)
        return formatFailure(
          `type entries start ${entriesStart} lies outside the chunk`,
        );
      if (base + header.headerSize + count * 4 > base + header.size)
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
      const config = renderConfig(view, base + 20, configSize);
      const failing = emitOrLimit(
        `    <type id="${hexRef(typeId + typeIdOffset)}" name="${escapeAttr(typeName)}" config="${escapeAttr(config)}">\n`,
      );
      if (failing !== undefined) return failing;
      const entriesBase = base + entriesStart;
      for (let index = 0; index < count; index++) {
        const rel = view.getUint32(base + header.headerSize + index * 4, true);
        if (rel === NO_ENTRY) continue;
        if (rel + 8 > header.size - entriesStart)
          return formatFailure(
            `entry ${index} of type ${typeId} lies outside the entry block`,
          );
        const entryBase = entriesBase + rel;
        const entrySize = view.getUint16(entryBase, true);
        if (entryBase + entrySize > base + header.size)
          return formatFailure(
            `entry ${index} of type ${typeId} extends past the chunk end`,
          );
        const entryFlags = view.getUint16(entryBase + 2, true);
        const keyIndex = view.getUint32(entryBase + 4, true);
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
        const attrs = [`id="${hexRef(id)}"`, `name="${escapeAttr(name)}"`];
        if ((specFlags?.[index] ?? 0) & SPEC_PUBLIC)
          attrs.push('public="true"');
        entryCount += 1;
        if (entryCount > ARSC_MAX_ENTRIES)
          return limitFailure(
            `table projects more than the ${ARSC_MAX_ENTRIES}-entry bound`,
          );
        if ((entryFlags & ENTRY_COMPLEX) === 0) {
          const valueSize = view.getUint16(entryBase + 8, true);
          if (
            valueSize < RES_VALUE_BYTES ||
            entryBase + 8 + valueSize > base + header.size
          )
            return formatFailure(
              `entry ${index} of type ${typeId} carries a truncated value`,
            );
          const valueType = view.getUint8(entryBase + 11);
          const valueData = view.getUint32(entryBase + 12, true);
          const rendered = globalPool
            ? renderTypedValue(valueType, valueData, globalPool)
            : undefined;
          if (rendered === undefined) {
            unrenderedValues += 1;
            attrs.push(
              `value="${hexRef(valueData)}"`,
              `type="0x${valueType.toString(16).padStart(2, "0")}"`,
            );
          } else {
            attrs.push(`value="${escapeAttr(rendered)}"`);
          }
          const line = `      <entry ${attrs.join(" ")}/>\n`;
          const inner = emitOrLimit(line);
          if (inner !== undefined) return inner;
          continue;
        }
        if (entrySize < 16)
          return formatFailure(
            `complex entry ${index} of type ${typeId} lacks the map header`,
          );
        const parent = view.getUint32(entryBase + 8, true);
        const mapCount = view.getUint32(entryBase + 12, true);
        if (entryBase + entrySize + mapCount * 12 > base + header.size)
          return formatFailure(
            `complex entry ${index} of type ${typeId} declares ${mapCount} items past the chunk end`,
          );
        if (parent !== 0) attrs.push(`parent="${hexRef(parent)}"`);
        const open = emitOrLimit(`      <entry ${attrs.join(" ")}>\n`);
        if (open !== undefined) return open;
        for (let m = 0; m < mapCount; m++) {
          const mapBase = entryBase + entrySize + m * 12;
          const mapName = view.getUint32(mapBase, true);
          const valueType = view.getUint8(mapBase + 7);
          const valueData = view.getUint32(mapBase + 8, true);
          const rendered = globalPool
            ? renderTypedValue(valueType, valueData, globalPool)
            : undefined;
          const itemAttrs = [`name="@${hexRef(mapName)}"`];
          if (rendered === undefined) {
            unrenderedValues += 1;
            itemAttrs.push(
              `value="${hexRef(valueData)}"`,
              `type="0x${valueType.toString(16).padStart(2, "0")}"`,
            );
          } else {
            itemAttrs.push(`value="${escapeAttr(rendered)}"`);
          }
          const item = emitOrLimit(`        <item ${itemAttrs.join(" ")}/>\n`);
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
        const pool = StringPool.parse(view, cursor, h, documentEnd, {
          maxStrings: ARSC_MAX_STRINGS,
          maxStringBytes: ARSC_MAX_STRING_BYTES,
        });
        if (!pool.ok) return pool;
        globalPool = pool.value;
      } else if (h.type === CHUNK_PACKAGE) {
        if (h.headerSize < PACKAGE_HEADER_BYTES)
          return formatFailure(
            `package header ${h.headerSize} is below the fixed ${PACKAGE_HEADER_BYTES} bytes`,
          );
        if (globalPool === undefined)
          return formatFailure("a package precedes the global string pool");
        if (
          !emit(
            `  <package id="${hexRef(view.getUint32(cursor + 8, true))}" name="${escapeAttr(readPackageName(view, cursor))}">\n`,
          )
        )
          return limitFailure(
            `projected output exceeds the ${ARSC_MAX_OUTPUT_BYTES}-byte bound`,
          );
        const packageEnd = cursor + h.size;
        const typeStringsAt = view.getUint32(cursor + 268, true);
        const keyStringsAt = view.getUint32(cursor + 276, true);
        const typeIdOffset = view.getUint32(cursor + 284, true);
        const packageId = view.getUint32(cursor + 8, true);
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
          view,
          cursor + typeStringsAt,
          typePoolHeader.value,
          packageEnd,
          {
            maxStrings: ARSC_MAX_STRINGS,
            maxStringBytes: ARSC_MAX_STRING_BYTES,
          },
        );
        if (!typeStrings.ok) return typeStrings;
        const keyStrings = StringPool.parse(
          view,
          cursor + keyStringsAt,
          keyPoolHeader.value,
          packageEnd,
          {
            maxStrings: ARSC_MAX_STRINGS,
            maxStringBytes: ARSC_MAX_STRING_BYTES,
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
            const specId = view.getUint8(inner + 8);
            const specCount = view.getUint32(inner + 12, true);
            if (s.headerSize + specCount * 4 > s.size)
              return formatFailure(
                `type spec ${specId} declares ${specCount} flags past the chunk end`,
              );
            const flags: number[] = new Array(specCount);
            for (let i = 0; i < specCount; i++)
              flags[i] = view.getUint32(inner + s.headerSize + i * 4, true);
            specs.set(specId, flags);
          } else if (s.type === CHUNK_TYPE) {
            const emitted = emitType(
              inner,
              s,
              typeStrings.value,
              keyStrings.value,
              packageId,
              typeIdOffset,
              specs.get(view.getUint8(inner + 8)),
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
    const xml = new Uint8Array(outBytes);
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
    return err({ kind: "format", message: "invalid file size" });
  if (fileBytes > ARSC_MAX_FILE_BYTES)
    return err({
      kind: "limit",
      message: `arsc file ${fileBytes} exceeds the ${ARSC_MAX_FILE_BYTES}-byte bound`,
      boundary: "file-size",
    });
  return ok(new BufferedArscDecoder(fileBytes));
};
