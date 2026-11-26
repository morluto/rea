import { Budget } from "../domain/budget.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { formatGuidLittleEndian, GUID_LENGTH } from "./UefiGuid.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

/**
 * TianoCore EDK2 / OVMF variable-store cartography.
 *
 * Regions signed by `gEfiVariableGuid` or `gEfiAuthenticatedVariableGuid`
 * follow UEFI PI / EDK2 `VariableFormat.h`. This module reports store headers
 * and variable records as observations; it never interprets variable bytes.
 */

/** EDK2 `gEfiVariableGuid` store signature (VariableFormat.h). */
const EFI_VARIABLE_GUID = "ddcf3616-3275-4164-98b6-fe85707ffe7d";
/** EDK2 `gEfiAuthenticatedVariableGuid` store signature (VariableFormat.h). */
const EFI_AUTHENTICATED_VARIABLE_GUID = "aaf32c78-947b-439a-a180-2e144ec37792";

const VARIABLE_STORE_HEADER_BYTES = 28;
const VARIABLE_HEADER_BYTES = 32;
const AUTHENTICATED_VARIABLE_HEADER_BYTES = 60;
const VARIABLE_DATA_START_ID = 0x55aa;
const VARIABLE_STORE_FORMATTED = 0x5a;
const VARIABLE_STORE_HEALTHY = 0xfe;
const HEADER_ALIGNMENT = 4;

const VAR_STATE = {
  inDeletedTransition: 0xfe,
  deleted: 0xfd,
  headerValidOnly: 0x7f,
  added: 0x3f,
} as const;

const guidToLittleEndianBytes = (guid: string): Buffer => {
  const [a, b, c, d, e] = guid.split("-");
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined
  )
    throw new Error(`invalid GUID ${guid}`);
  const out = Buffer.alloc(GUID_LENGTH);
  out.writeUInt32LE(Number.parseInt(a, 16), 0);
  out.writeUInt16LE(Number.parseInt(b, 16), 4);
  out.writeUInt16LE(Number.parseInt(c, 16), 6);
  Buffer.from(`${d}${e}`, "hex").copy(out, 8);
  return out;
};

const EFI_VARIABLE_GUID_BYTES = guidToLittleEndianBytes(EFI_VARIABLE_GUID);
const EFI_AUTHENTICATED_VARIABLE_GUID_BYTES = guidToLittleEndianBytes(
  EFI_AUTHENTICATED_VARIABLE_GUID,
);

const alignUp = (value: number, alignment: number): number =>
  (value + (alignment - 1)) & ~(alignment - 1);

/** Observed EDK2 variable State after erase-polarity bit clearing. */
export type Edk2VariableState =
  | "added"
  | "in-deleted-transition"
  | "deleted"
  | "header-only"
  | "unknown";

const classifyEdk2VariableState = (state: number): Edk2VariableState => {
  if (state === VAR_STATE.added) return "added";
  if (state === (VAR_STATE.added & VAR_STATE.inDeletedTransition))
    return "in-deleted-transition";
  if (
    state === (VAR_STATE.added & VAR_STATE.deleted) ||
    state ===
      (VAR_STATE.added & VAR_STATE.inDeletedTransition & VAR_STATE.deleted)
  )
    return "deleted";
  if (state === VAR_STATE.headerValidOnly) return "header-only";
  return "unknown";
};

/** One parsed EDK2 variable header; data bytes stay uninterpreted. */
export interface Edk2NvramVariable {
  readonly offset: number;
  readonly name: string | null;
  readonly state: Edk2VariableState;
  readonly stateRaw: number;
  readonly attributes: number;
  readonly vendorGuid: string;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly endOffset: number;
}

/** One EDK2 `VARIABLE_STORE_HEADER` region and its variable records. */
export interface Edk2NvramStore {
  readonly offset: number;
  readonly storeGuid: string;
  readonly size: number;
  readonly storeFormat: number;
  readonly storeState: number;
  readonly authenticated: boolean;
  readonly variables: readonly Edk2NvramVariable[];
}

/** Outcome of scanning an image for EDK2 variable stores. */
export interface Edk2NvramScan {
  readonly stores: readonly Edk2NvramStore[];
  readonly coverage: "complete" | "partial";
  readonly limitations: readonly string[];
}

const readUtf16Name = (
  reader: BinaryReader,
  start: number,
  byteLength: number,
): string | null => {
  if (byteLength < 2 || byteLength % 2 !== 0) return null;
  const end = start + byteLength;
  if (end > reader.bytes.length) return null;
  if (reader.u16(end - 2) !== 0) return null;
  for (let cursor = start; cursor < end - 2; cursor += 2) {
    const unit = reader.u16(cursor);
    if (unit === 0) return null;
    if (unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff)) return null;
  }
  return reader.bytes.toString("utf16le", start, end - 2);
};

type ParsedEdk2Variable =
  | { kind: "end" }
  | { kind: "erased" }
  | { kind: "invalid"; endOffset: number; detail: string }
  | { kind: "active"; variable: Edk2NvramVariable };

const parseEdk2Variable = (
  reader: BinaryReader,
  offset: number,
  storeEnd: number,
  authenticated: boolean,
): ParsedEdk2Variable => {
  const headerBytes = authenticated
    ? AUTHENTICATED_VARIABLE_HEADER_BYTES
    : VARIABLE_HEADER_BYTES;
  if (offset + 2 > storeEnd) return { kind: "end" };
  const startId = reader.u16(offset);
  if (startId === 0xffff) return { kind: "erased" };
  if (startId !== VARIABLE_DATA_START_ID)
    return {
      kind: "invalid",
      endOffset: offset + HEADER_ALIGNMENT,
      detail: `EDK2 variable at 0x${offset.toString(16)} has StartId 0x${startId.toString(16)} (expected 0x55aa).`,
    };
  if (offset + headerBytes > storeEnd)
    return {
      kind: "invalid",
      endOffset: storeEnd,
      detail: `EDK2 variable at 0x${offset.toString(16)} is truncated before its header ends.`,
    };

  const stateRaw = reader.u8(offset + 2);
  const attributes = reader.u32(offset + 4);
  const nameSizeOffset = authenticated ? offset + 36 : offset + 8;
  const dataSizeOffset = authenticated ? offset + 40 : offset + 12;
  const vendorGuidOffset = authenticated ? offset + 44 : offset + 16;
  const nameSize = reader.u32(nameSizeOffset);
  const dataSize = reader.u32(dataSizeOffset);
  const vendorGuid = formatGuidLittleEndian(reader.bytes, vendorGuidOffset);
  if (vendorGuid === null)
    return {
      kind: "invalid",
      endOffset: alignUp(offset + headerBytes, HEADER_ALIGNMENT),
      detail: `EDK2 variable at 0x${offset.toString(16)} has an unreadable VendorGuid.`,
    };

  const nameStart = offset + headerBytes;
  const dataStart = nameStart + nameSize;
  const rawEnd = dataStart + dataSize;
  if (
    nameSize > storeEnd - nameStart ||
    dataSize > storeEnd - dataStart ||
    rawEnd > storeEnd
  )
    return {
      kind: "invalid",
      endOffset: alignUp(
        Math.min(storeEnd, offset + headerBytes),
        HEADER_ALIGNMENT,
      ),
      detail: `EDK2 variable at 0x${offset.toString(16)} declares NameSize/DataSize beyond the store.`,
    };

  const name = readUtf16Name(reader, nameStart, nameSize);
  if (name === null && nameSize !== 0)
    return {
      kind: "invalid",
      endOffset: alignUp(rawEnd, HEADER_ALIGNMENT),
      detail: `EDK2 variable at 0x${offset.toString(16)} has a malformed UTF-16LE name.`,
    };

  return {
    kind: "active",
    variable: {
      offset,
      name,
      state: classifyEdk2VariableState(stateRaw),
      stateRaw,
      attributes,
      vendorGuid,
      dataOffset: dataStart,
      dataLength: dataSize,
      endOffset: alignUp(rawEnd, HEADER_ALIGNMENT),
    },
  };
};

interface Edk2StoreWalk {
  readonly reader: BinaryReader;
  readonly maxStores: number;
  readonly checkpoint: () => void;
  readonly records: Budget;
  readonly occupied: Set<number>;
  readonly stores: Edk2NvramStore[];
  readonly noteOmission: (detail: string) => void;
  stop: boolean;
}

const collectStoreAt = (
  walk: Edk2StoreWalk,
  offset: number,
  authenticated: boolean,
): void => {
  const { reader, checkpoint, records, occupied, stores, noteOmission } = walk;
  const image = reader.bytes;
  checkpoint();
  if (walk.stop || occupied.has(offset)) return;
  if (offset + VARIABLE_STORE_HEADER_BYTES > image.length) return;
  if (!records.tryCharge(1)) {
    noteOmission(
      `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached at EDK2 store candidate 0x${offset.toString(16)}.`,
    );
    walk.stop = true;
    return;
  }
  const storeFormat = reader.u8(offset + 20);
  const storeState = reader.u8(offset + 21);
  if (
    storeFormat !== VARIABLE_STORE_FORMATTED ||
    storeState !== VARIABLE_STORE_HEALTHY
  )
    return;
  const size = reader.u32(offset + 16);
  if (size < VARIABLE_STORE_HEADER_BYTES || offset + size > image.length)
    return;
  const storeGuid = formatGuidLittleEndian(image, offset);
  if (storeGuid === null) return;

  if (stores.length >= walk.maxStores) {
    noteOmission(
      `Stopped after ${walk.maxStores} EDK2 variable stores; additional stores exist.`,
    );
    walk.stop = true;
    return;
  }

  occupied.add(offset);
  const storeEnd = offset + size;
  const variables: Edk2NvramVariable[] = [];
  let cursor = offset + VARIABLE_STORE_HEADER_BYTES;
  while (cursor + 2 <= storeEnd) {
    checkpoint();
    if (!records.tryCharge(1)) {
      noteOmission(
        `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached at EDK2 variable 0x${cursor.toString(16)}.`,
      );
      walk.stop = true;
      break;
    }
    const parsed = parseEdk2Variable(reader, cursor, storeEnd, authenticated);
    if (parsed.kind === "erased" || parsed.kind === "end") break;
    if (parsed.kind === "invalid") {
      noteOmission(parsed.detail);
      cursor = parsed.endOffset;
      continue;
    }
    variables.push(parsed.variable);
    if (parsed.variable.endOffset <= cursor) {
      noteOmission(
        `EDK2 variable at 0x${cursor.toString(16)} did not advance the store cursor.`,
      );
      break;
    }
    cursor = parsed.variable.endOffset;
  }

  stores.push({
    offset,
    storeGuid,
    size,
    storeFormat,
    storeState,
    authenticated,
    variables,
  });
};

/** Scan a raw image for EDK2 / OVMF `VARIABLE_STORE_HEADER` regions. */
export const scanEdk2VariableStores = (
  image: Buffer,
  maxStores: number,
  checkpoint: () => void = () => {},
): Edk2NvramScan => {
  const stores: Edk2NvramStore[] = [];
  const limitations: string[] = [];
  let partial = false;
  const reader = new BinaryReader(image, true, "EDK2 variable store");
  const walk: Edk2StoreWalk = {
    reader,
    maxStores,
    checkpoint,
    records: new Budget(UEFI_FIRMWARE_LIMITS.scanRecords),
    occupied: new Set(),
    stores,
    noteOmission: (detail) => {
      partial = true;
      if (limitations.length < 512) limitations.push(detail);
    },
    stop: false,
  };

  const searchGuid = (needle: Buffer, authenticated: boolean): void => {
    let searchFrom = 0;
    const last = image.length - VARIABLE_STORE_HEADER_BYTES;
    while (!walk.stop && searchFrom <= last) {
      checkpoint();
      const hit = image.indexOf(needle, searchFrom);
      if (hit < 0) break;
      collectStoreAt(walk, hit, authenticated);
      searchFrom = hit + 1;
    }
  };

  searchGuid(EFI_AUTHENTICATED_VARIABLE_GUID_BYTES, true);
  searchGuid(EFI_VARIABLE_GUID_BYTES, false);

  stores.sort((left, right) => left.offset - right.offset);
  return {
    stores,
    coverage: partial ? "partial" : "complete",
    limitations,
  };
};
