import { crc32 } from "node:zlib";
import { byteToHex } from "../../kernel/byteToHex.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { decodeStrictUtf8, isStrictUtf8 } from "../strictUtf8.js";
import {
  BinaryReader,
  readUint16At,
  readUint32At,
} from "../binaryContainer.js";
import {
  ESP_NVS_ENTRY_BYTES,
  ESP_NVS_ENTRY_COUNT,
  ESP_NVS_ENTRY_DATA_OFFSET,
  type EspNvsDataType,
  type EspNvsEntry,
} from "./espNvs.js";

const CRC_SEED = 0xffff_ffff;
const ITEM_DATA_OFFSET = 24;
export const MAX_BLOB_PREVIEW_BYTES = 128;
export const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));
const itemHeaderCrcScratch = Buffer.allocUnsafe(28);

/** Compute ESP-IDF `esp_rom_crc32_le(0xffffffff, buf, len)`. */
export const espIdfCrc32 = (bytes: Uint8Array): number =>
  crc32(bytes, CRC_SEED) >>> 0;

/** Compute ESP-IDF NVS 32-byte item header CRC over `[0..4) || [8..32)`. */
export const computeNvsItemHeaderCrc = (slot32: Uint8Array): number => {
  itemHeaderCrcScratch.set(slot32.subarray(0, 4), 0);
  itemHeaderCrcScratch.set(slot32.subarray(8, 32), 4);
  return espIdfCrc32(itemHeaderCrcScratch);
};

export const readBitmapSlotState = (
  bitmap32: Uint8Array,
  slotIndex: number,
): "empty" | "written" | "erased" | "illegal" => {
  const byteIdx = slotIndex >>> 2;
  const shift = (slotIndex & 3) * 2;
  const bits = (bitmap32[byteIdx]! >>> shift) & 3;
  if (bits === 3) return "empty";
  if (bits === 2) return "written";
  if (bits === 0) return "erased";
  return "illegal";
};

/** Decode bytes as UTF-8, keeping a leading U+FEFF as stored, or null when malformed. */
const utf8OrNull = (bytes: Uint8Array): string | null =>
  isStrictUtf8(bytes) ? decodeStrictUtf8(bytes, "preserve") : null;

export interface DecodedNvsKey {
  readonly key: string;
  /** Canonical byte-exact lookup identity so distinct byte encodings never merge. */
  readonly keyId: string;
  readonly problem?: string;
}

/**
 * Decode a 16-byte NVS key. ESP-IDF writes at most 15 bytes and a NUL, so a
 * key without a NUL or with invalid UTF-8 is reported; its display text falls
 * back to Latin-1 while lookup keeps the exact stored byte sequence before NUL.
 */
export const decodeNvsKey = (bytes16: Uint8Array): DecodedNvsKey => {
  const nul = bytes16.indexOf(0);
  const slice = nul === -1 ? bytes16 : bytes16.subarray(0, nul);
  const keyId = `${nul === -1 ? "raw" : "nul"}:${Buffer.from(slice).toString("hex")}`;
  const text = utf8OrNull(slice);
  if (nul !== -1 && text !== null) return { key: text, keyId };
  return {
    key: Buffer.from(slice).toString("latin1"),
    keyId,
    problem:
      nul === -1
        ? "key has no NUL terminator within its 16 bytes"
        : "key is not valid UTF-8 and is shown byte-for-byte as Latin-1",
  };
};

export type PendingNvsEntry = Omit<EspNvsEntry, "namespace"> & {
  readonly keyId: string;
};

export interface RawBlobChunk {
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly entryIndex: number;
  readonly fileOffset: number;
  readonly nsIndex: number;
  readonly key: string;
  readonly keyId: string;
  readonly chunkIndex: number;
  readonly span: number;
  readonly payload: Buffer;
  readonly crcValid: boolean;
}

export interface RawBlobIndex {
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly entryIndex: number;
  readonly fileOffset: number;
  readonly nsIndex: number;
  readonly key: string;
  readonly keyId: string;
  readonly totalSize: number;
  readonly chunkCount: number;
  readonly chunkStart: number;
  readonly headerCrcValid: boolean;
}

/** ESP-IDF `ItemType` codes (`nvs_handle.hpp`, `nvs.h`). */
export const ITEM_TYPE = {
  SZ: 0x21,
  BLOB: 0x41,
  BLOB_DATA: 0x42,
  BLOB_IDX: 0x48,
  U8: 0x01,
} as const;
/** ESP-IDF `Item::CHUNK_ANY`: the chunk index of every item that is not `BLOB_DATA`. */
const CHUNK_ANY = 0xff;
/** Namespace index 0 holds namespace definitions (`NVS_CONST_NS_INDEX`). */
const NAMESPACE_INDEX = 0;

type PrimitiveValue =
  | { readonly dataType: EspNvsDataType; readonly integerText: string }
  | { readonly dataType: EspNvsDataType; readonly floatText: string };

const integer = (
  dataType: EspNvsDataType,
  read: (reader: BinaryReader, offset: number) => bigint | number,
) => ({
  dataType,
  read: (reader: BinaryReader, offset: number): PrimitiveValue => ({
    dataType,
    integerText: String(read(reader, offset)),
  }),
});
const formatFloat = (value: number): string =>
  Object.is(value, -0) ? "-0" : String(value);

const float = (
  dataType: EspNvsDataType,
  read: (reader: BinaryReader, offset: number) => number,
) => ({
  dataType,
  read: (reader: BinaryReader, offset: number): PrimitiveValue => ({
    dataType,
    floatText: formatFloat(read(reader, offset)),
  }),
});

/** The one-entry item types and their little-endian 8-byte value encodings. */
const PRIMITIVE_TYPES: ReadonlyMap<
  number,
  {
    readonly dataType: EspNvsDataType;
    readonly read: (reader: BinaryReader, offset: number) => PrimitiveValue;
  }
> = new Map([
  [0x01, integer("u8", (r, o) => r.u8(o))],
  [0x11, integer("i8", (r, o) => r.i8(o))],
  [0x02, integer("u16", (r, o) => r.u16(o))],
  [0x12, integer("i16", (r, o) => r.i16(o))],
  [0x04, integer("u32", (r, o) => r.u32(o))],
  [0x14, integer("i32", (r, o) => r.i32(o))],
  [0x08, integer("u64", (r, o) => r.word(o, 64))],
  [0x18, integer("i64", (r, o) => r.i64(o))],
  [0x24, float("float", (r, o) => r.f32(o))],
  [0x28, float("double", (r, o) => r.f64(o))],
]);

export interface DecodedSingleSlotResult {
  readonly consumedSlots: number;
  readonly namespaceDef?: {
    readonly id: number;
    readonly name: string;
    readonly pageIndex: number;
    readonly entryIndex: number;
  };
  readonly immediateEntry?: PendingNvsEntry;
  readonly blobChunk?: RawBlobChunk;
  readonly blobIndex?: RawBlobIndex;
  /** The item header failed CRC32 or ESP-IDF's consistency rules, so none of its fields were trusted. */
  readonly inconsistentHeader?: boolean;
  /** The header was trusted but the item itself is damaged or unusable. */
  readonly damagedItem?: boolean;
  readonly anomalies: readonly string[];
}

const ENTRY_BYTES = ESP_NVS_ENTRY_BYTES;
const ENTRIES_PER_PAGE = ESP_NVS_ENTRY_COUNT;
/** ESP-IDF `(UINT8_MAX / 2) * (ENTRY_COUNT - 1) * ENTRY_SIZE`: two version ranges of chunk indexes. */
const MAX_BLOB_INDEX_DATA_BYTES =
  Math.floor(255 / 2) * (ENTRIES_PER_PAGE - 1) * ENTRY_BYTES;

/**
 * ESP-IDF `Item::checkHeaderConsistency` after the CRC32: one-entry types use
 * span 1, `BLOB_IDX` uses span 1 and chunk index 0xff with a bounded size,
 * `BLOB_DATA` never uses chunk index 0xff, and a variable item's span is one
 * header entry plus its data rounded up to whole entries, within the page.
 * Every other type is invalid. Returns the reason, or undefined when consistent.
 */
const itemHeaderInconsistency = (
  slot: Uint8Array,
  entryIndex: number,
): string | undefined => {
  const typeCode = slot[1]!;
  const span = slot[2]!;
  const chunkIndex = slot[3]!;
  const typeText = `0x${byteToHex(typeCode)}`;
  if (PRIMITIVE_TYPES.has(typeCode))
    return span === 1
      ? undefined
      : `declares span ${String(span)} for one-entry type ${typeText}`;
  if (typeCode === ITEM_TYPE.BLOB_IDX) {
    if (span !== 1) return `declares BLOB_IDX span ${String(span)}`;
    if (chunkIndex !== CHUNK_ANY)
      return `declares BLOB_IDX chunk index ${String(chunkIndex)} instead of 0xff`;
    const dataSize = readUint32At(slot, 24, true);
    return dataSize > MAX_BLOB_INDEX_DATA_BYTES
      ? `declares BLOB_IDX size ${String(dataSize)} above the ${String(MAX_BLOB_INDEX_DATA_BYTES)}-byte maximum`
      : undefined;
  }
  if (isVariableLengthType(typeCode)) {
    if (typeCode === ITEM_TYPE.BLOB_DATA && chunkIndex === CHUNK_ANY)
      return "declares BLOB_DATA chunk index 0xff";
    const dataSize = readUint16At(slot, 24, true);
    const remainingEntries = ENTRIES_PER_PAGE - entryIndex;
    if (dataSize > (remainingEntries - 1) * ENTRY_BYTES)
      return `declares ${String(dataSize)} data bytes past the end of the page`;
    if (span > remainingEntries)
      return `declares span ${String(span)} past the end of the page`;
    const expectedSpan = 1 + Math.ceil(dataSize / ENTRY_BYTES);
    return span === expectedSpan
      ? undefined
      : `declares span ${String(span)} for ${String(dataSize)} data bytes (expected ${String(expectedSpan)})`;
  }
  return `has unrecognized item type ${typeText}`;
};

/** ESP-IDF `isVariableLengthType`: SZ, BLOB (v1) and BLOB_DATA carry a length and data CRC32. */
const isVariableLengthType = (typeCode: number): boolean =>
  typeCode === ITEM_TYPE.SZ ||
  typeCode === ITEM_TYPE.BLOB ||
  typeCode === ITEM_TYPE.BLOB_DATA;

export const entryCompleteness = (
  crcValid: boolean,
  chunksComplete: boolean,
): EspNvsEntry["completeness"] => {
  if (!crcValid) return "crc_mismatch";
  if (!chunksComplete) return "missing_chunks";
  return "complete";
};

interface SlotContext {
  readonly pageBytes: Buffer;
  readonly pageReader: BinaryReader;
  readonly bitmap: Uint8Array;
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly pageFileOffset: number;
  readonly entryIndex: number;
}

const slotLabel = (context: SlotContext, key?: string): string => {
  const offset =
    context.pageFileOffset +
    ESP_NVS_ENTRY_DATA_OFFSET +
    context.entryIndex * ENTRY_BYTES;
  const name = key === undefined ? "" : ` ("${key}")`;
  return `Page ${String(context.pageIndex)} slot ${String(context.entryIndex)} at offset 0x${offset.toString(16)}${name}`;
};

export const emptyValues = {
  value_text: null,
  value_integer: null,
  value_float: null,
  blob_size: null,
  blob_preview_hex: null,
  blob_sha256: null,
} as const;

export const blobValues = (payload: Buffer) => ({
  blob_size: payload.length,
  blob_preview_hex: payload.subarray(0, MAX_BLOB_PREVIEW_BYTES).toString("hex"),
  blob_sha256: sha256Hex(payload),
});

/** Decode a consistent SZ, BLOB (v1) or BLOB_DATA item and its payload entries. */
const decodeVariableSpanItem = (
  context: SlotContext,
  header: {
    readonly nsIndex: number;
    readonly typeCode: number;
    readonly span: number;
    readonly chunkIndex: number;
    readonly key: string;
    readonly keyId: string;
    readonly data8: Uint8Array;
  },
  anomalies: string[],
): DecodedSingleSlotResult => {
  const { nsIndex, typeCode, span, chunkIndex, key, keyId, data8 } = header;
  const { pageBytes, pageIndex, pageSeqNo, pageFileOffset, entryIndex } =
    context;
  // The consistency check bounds the declared size by the page.
  const dataSize = readUint16At(data8, 0, true);
  const declaredDataCrc = readUint32At(data8, 4, true);
  const payloadStart =
    ESP_NVS_ENTRY_DATA_OFFSET + (entryIndex + 1) * ENTRY_BYTES;
  const payload = Buffer.from(
    pageBytes.subarray(payloadStart, payloadStart + dataSize),
  );
  const crcValid = espIdfCrc32(payload) === declaredDataCrc;
  const fileOffset =
    pageFileOffset + ESP_NVS_ENTRY_DATA_OFFSET + entryIndex * ENTRY_BYTES;
  if (!crcValid)
    anomalies.push(
      `${slotLabel(context, key)} failed its data CRC32${typeCode === ITEM_TYPE.BLOB_DATA ? ` (chunk ${String(chunkIndex)})` : ""}.`,
    );

  if (typeCode === ITEM_TYPE.BLOB_DATA) {
    return {
      consumedSlots: span,
      blobChunk: {
        pageIndex,
        pageSeqNo,
        entryIndex,
        fileOffset,
        nsIndex,
        key,
        keyId,
        chunkIndex,
        span,
        payload,
        crcValid,
      },
      ...(crcValid ? {} : { damagedItem: true }),
      anomalies,
    };
  }
  const base = {
    page_index: pageIndex,
    entry_index: entryIndex,
    file_offset: fileOffset,
    namespace_id: nsIndex,
    key,
    keyId,
    raw_type_code: typeCode,
    span,
    crc_valid: crcValid,
    completeness: entryCompleteness(crcValid, true),
    superseded: false,
  };
  if (typeCode === ITEM_TYPE.SZ) {
    const nul = payload.indexOf(0);
    const text = utf8OrNull(nul === -1 ? payload : payload.subarray(0, nul));
    if (text === null)
      anomalies.push(
        `${slotLabel(context, key)} stores a string that is not valid UTF-8; its bytes are reported as a blob digest and preview.`,
      );
    return {
      consumedSlots: span,
      immediateEntry: {
        ...base,
        data_type: "sz",
        ...emptyValues,
        ...(text === null ? blobValues(payload) : { value_text: text }),
      },
      ...(crcValid ? {} : { damagedItem: true }),
      anomalies,
    };
  }
  return {
    consumedSlots: span,
    immediateEntry: {
      ...base,
      data_type: "blob_v1",
      ...emptyValues,
      ...blobValues(payload),
    },
    ...(crcValid ? {} : { damagedItem: true }),
    anomalies,
  };
};

/** Decode one written NVS entry starting at `entryIndex` (0..125). */
export const decodeWrittenNvsSlot = (
  context: SlotContext,
): DecodedSingleSlotResult => {
  const {
    pageBytes,
    pageReader,
    bitmap,
    pageIndex,
    pageSeqNo,
    pageFileOffset,
    entryIndex,
  } = context;
  const slotOffset = ESP_NVS_ENTRY_DATA_OFFSET + entryIndex * ENTRY_BYTES;
  const slotFileOffset = pageFileOffset + slotOffset;
  const slot = pageBytes.subarray(slotOffset, slotOffset + ENTRY_BYTES);

  // Never trust span, key, or type fields from a header that fails CRC32 or
  // ESP-IDF's consistency rules: a damaged span would skip intact entries,
  // and the payload entries of a damaged item are not item headers.
  const headerProblem =
    computeNvsItemHeaderCrc(slot) === readUint32At(slot, 4, true)
      ? itemHeaderInconsistency(slot, entryIndex)
      : "failed its item-header CRC32";
  if (headerProblem !== undefined) {
    return {
      consumedSlots: 1,
      inconsistentHeader: true,
      anomalies: [
        `${slotLabel(context)} ${headerProblem}; its fields were not trusted and the walk advanced 1 slot.`,
      ],
    };
  }

  const nsIndex = slot[0]!;
  const typeCode = slot[1]!;
  const span = slot[2]!;
  const chunkIndex = slot[3]!;
  const decodedKey = decodeNvsKey(slot.subarray(8, 24));
  const { key, keyId } = decodedKey;
  const data8 = slot.subarray(ITEM_DATA_OFFSET, ENTRY_BYTES);
  const anomalies: string[] = [];
  if (decodedKey.problem !== undefined)
    anomalies.push(`${slotLabel(context, key)} ${decodedKey.problem}.`);

  // Every continuation slot of a multi-slot item must also be marked WRITTEN in
  // the page's 2-bit entry-state bitmap; otherwise the write or erase was torn.
  if (span > 1) {
    for (let offset = 1; offset < span; offset += 1) {
      const continuationSlot = entryIndex + offset;
      const slotState = readBitmapSlotState(bitmap, continuationSlot);
      if (slotState !== "written") {
        anomalies.push(
          `${slotLabel(context, key)} declares span ${String(span)} (slots ${String(entryIndex)}..${String(entryIndex + span - 1)}), but continuation slot ${String(continuationSlot)} has bitmap state ${slotState} instead of written; the unfinished item was skipped.`,
        );
        return {
          consumedSlots: offset + 1,
          damagedItem: true,
          anomalies,
        };
      }
    }
  }

  if (nsIndex === NAMESPACE_INDEX) {
    const nsId = data8[0]!;
    if (typeCode === ITEM_TYPE.U8 && nsId >= 1 && nsId <= 254) {
      return {
        consumedSlots: 1,
        namespaceDef: { id: nsId, name: key, pageIndex, entryIndex },
        anomalies,
      };
    }
    anomalies.push(
      typeCode === ITEM_TYPE.U8
        ? `${slotLabel(context, key)} defines namespace id ${String(nsId)} outside 1..254.`
        : `${slotLabel(context, key)} has namespace index 0, reserved for namespace definitions, with item type 0x${byteToHex(typeCode)}; it was not decoded.`,
    );
    return { consumedSlots: span, damagedItem: true, anomalies };
  }

  if (typeCode === ITEM_TYPE.BLOB_IDX) {
    return {
      consumedSlots: 1,
      blobIndex: {
        pageIndex,
        pageSeqNo,
        entryIndex,
        fileOffset: slotFileOffset,
        nsIndex,
        key,
        keyId,
        totalSize: readUint32At(data8, 0, true),
        chunkCount: data8[4]!,
        chunkStart: data8[5]!,
        headerCrcValid: true,
      },
      anomalies,
    };
  }

  if (isVariableLengthType(typeCode)) {
    return decodeVariableSpanItem(
      context,
      { nsIndex, typeCode, span, chunkIndex, key, keyId, data8 },
      anomalies,
    );
  }

  // The consistency check admits only one-entry primitive types here.
  const prim = PRIMITIVE_TYPES.get(typeCode)!.read(
    pageReader,
    slotOffset + ITEM_DATA_OFFSET,
  );
  return {
    consumedSlots: 1,
    immediateEntry: {
      page_index: pageIndex,
      entry_index: entryIndex,
      file_offset: slotFileOffset,
      namespace_id: nsIndex,
      key,
      keyId,
      data_type: prim.dataType,
      raw_type_code: typeCode,
      span: 1,
      ...emptyValues,
      ...("integerText" in prim
        ? { value_integer: prim.integerText }
        : { value_float: prim.floatText }),
      crc_valid: true,
      completeness: "complete",
      superseded: false,
    },
    anomalies,
  };
};
