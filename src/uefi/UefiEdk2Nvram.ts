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

interface OccupiedRange {
  readonly start: number;
  readonly end: number;
}

const rangesOverlap = (left: OccupiedRange, right: OccupiedRange): boolean =>
  left.start < right.end && right.start < left.end;

const rangeOccupied = (
  occupied: readonly OccupiedRange[],
  range: OccupiedRange,
): boolean => occupied.some((entry) => rangesOverlap(entry, range));

const ERASED_BLOCK_BYTES = 65_536;
const ERASED_BLOCK = Buffer.alloc(ERASED_BLOCK_BYTES, 0xff);

const isErasedRange = (
  image: Buffer,
  start: number,
  end: number,
  checkpoint: () => void,
): boolean => {
  for (let cursor = start; cursor < end; cursor += ERASED_BLOCK_BYTES) {
    checkpoint();
    const blockEnd = Math.min(cursor + ERASED_BLOCK_BYTES, end);
    const length = blockEnd - cursor;
    if (image.compare(ERASED_BLOCK, 0, length, cursor, blockEnd) !== 0)
      return false;
  }
  return true;
};

type NameDecode =
  | { kind: "empty" }
  | { kind: "ok"; name: string }
  | { kind: "malformed" }
  | { kind: "budget" };

const readUtf16Name = (
  reader: BinaryReader,
  start: number,
  byteLength: number,
  nameBytes: Budget,
): NameDecode => {
  if (byteLength === 0) return { kind: "empty" };
  if (byteLength < 2 || byteLength % 2 !== 0) return { kind: "malformed" };
  const end = start + byteLength;
  if (end > reader.bytes.length) return { kind: "malformed" };
  if (reader.u16(end - 2) !== 0) return { kind: "malformed" };
  for (let cursor = start; cursor < end - 2; cursor += 2) {
    const unit = reader.u16(cursor);
    if (unit === 0) return { kind: "malformed" };
    if (unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff))
      return { kind: "malformed" };
  }
  const decodedBytes = byteLength - 2;
  if (!nameBytes.tryCharge(decodedBytes)) return { kind: "budget" };
  return {
    kind: "ok",
    name: reader.bytes.toString("utf16le", start, end - 2),
  };
};

type ParsedEdk2Variable =
  | { kind: "end" }
  | { kind: "erased" }
  | { kind: "invalid"; detail: string }
  | {
      kind: "active";
      variable: Edk2NvramVariable;
      limitation: string | null;
    };

const parseEdk2Variable = (
  reader: BinaryReader,
  offset: number,
  storeEnd: number,
  authenticated: boolean,
  nameBytes: Budget,
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
      detail: `EDK2 variable at 0x${offset.toString(16)} has StartId 0x${startId.toString(16)} (expected 0x55aa).`,
    };
  if (offset + headerBytes > storeEnd)
    return {
      kind: "invalid",
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
      detail: `EDK2 variable at 0x${offset.toString(16)} declares NameSize/DataSize beyond the store.`,
    };

  const decoded = readUtf16Name(reader, nameStart, nameSize, nameBytes);
  let name: string | null = null;
  let limitation: string | null = null;
  if (decoded.kind === "ok") name = decoded.name;
  else if (decoded.kind === "malformed")
    limitation = `EDK2 variable at 0x${offset.toString(16)} has a malformed UTF-16LE name.`;
  else if (decoded.kind === "budget")
    limitation = `EDK2 decoded variable-name budget ${UEFI_FIRMWARE_LIMITS.decodedBytes} bytes reached at 0x${offset.toString(16)}.`;

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
    limitation,
  };
};

interface Edk2StoreWalk {
  readonly reader: BinaryReader;
  readonly maxStores: number;
  readonly checkpoint: () => void;
  readonly records: Budget;
  readonly nameBytes: Budget;
  readonly occupied: OccupiedRange[];
  readonly stores: Edk2NvramStore[];
  readonly noteOmission: (detail: string) => void;
  stop: boolean;
}

const collectStoreAt = (
  walk: Edk2StoreWalk,
  offset: number,
  authenticated: boolean,
): void => {
  const {
    reader,
    checkpoint,
    records,
    nameBytes,
    occupied,
    stores,
    noteOmission,
  } = walk;
  const image = reader.bytes;
  checkpoint();
  if (walk.stop) return;
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
  const declaredSize = reader.u32(offset + 16);
  if (declaredSize < VARIABLE_STORE_HEADER_BYTES) return;
  const available = image.length - offset;
  const readableSize = Math.min(declaredSize, available);
  // Skip candidates starting inside an already-claimed store extent.
  if (
    rangeOccupied(occupied, {
      start: offset,
      end: offset + VARIABLE_STORE_HEADER_BYTES,
    })
  )
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

  const storeEnd = offset + readableSize;
  if (declaredSize > available)
    noteOmission(
      `EDK2 store at 0x${offset.toString(16)} declares size 0x${declaredSize.toString(16)} but only 0x${available.toString(16)} bytes remain; reporting readable extent.`,
    );

  const variables: Edk2NvramVariable[] = [];
  let cursor = offset + VARIABLE_STORE_HEADER_BYTES;
  let claimedEnd = cursor;
  let sawInvalid = false;
  while (cursor < storeEnd) {
    checkpoint();
    if (cursor + 2 > storeEnd) {
      if (!isErasedRange(image, cursor, storeEnd, checkpoint))
        noteOmission(
          `EDK2 store at 0x${offset.toString(16)} has a non-erased one-byte suffix at 0x${cursor.toString(16)}.`,
        );
      else if (!sawInvalid) claimedEnd = storeEnd;
      break;
    }
    if (!records.tryCharge(1)) {
      noteOmission(
        `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached at EDK2 variable 0x${cursor.toString(16)}.`,
      );
      walk.stop = true;
      break;
    }
    const parsed = parseEdk2Variable(
      reader,
      cursor,
      storeEnd,
      authenticated,
      nameBytes,
    );
    if (parsed.kind === "erased") {
      if (!isErasedRange(image, cursor, storeEnd, checkpoint)) {
        noteOmission(
          `EDK2 store at 0x${offset.toString(16)} has a non-erased suffix after 0xffff at 0x${cursor.toString(16)}.`,
        );
        claimedEnd = Math.max(claimedEnd, cursor + 2);
      } else if (!sawInvalid) {
        claimedEnd = storeEnd;
      }
      break;
    }
    if (parsed.kind === "end") break;
    if (parsed.kind === "invalid") {
      sawInvalid = true;
      noteOmission(parsed.detail);
      break;
    }
    if (parsed.limitation !== null) noteOmission(parsed.limitation);
    variables.push(parsed.variable);
    claimedEnd = Math.max(claimedEnd, parsed.variable.endOffset);
    if (parsed.variable.endOffset <= cursor) {
      noteOmission(
        `EDK2 variable at 0x${cursor.toString(16)} did not advance the store cursor.`,
      );
      break;
    }
    cursor = parsed.variable.endOffset;
  }

  occupied.push({ start: offset, end: Math.min(storeEnd, claimedEnd) });
  stores.push({
    offset,
    storeGuid,
    size: declaredSize,
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
    nameBytes: new Budget(UEFI_FIRMWARE_LIMITS.decodedBytes),
    occupied: [],
    stores,
    noteOmission: (detail) => {
      partial = true;
      if (limitations.length < 512) limitations.push(detail);
    },
    stop: false,
  };

  // Merge both GUID searches in ascending offset order so an enclosing store
  // is always inspected before an embedded signature inside its variable data.
  const last = image.length - VARIABLE_STORE_HEADER_BYTES;
  let nextAuth =
    last >= 0 ? image.indexOf(EFI_AUTHENTICATED_VARIABLE_GUID_BYTES, 0) : -1;
  let nextPlain = last >= 0 ? image.indexOf(EFI_VARIABLE_GUID_BYTES, 0) : -1;
  while (!walk.stop) {
    const authValid = nextAuth >= 0 && nextAuth <= last;
    const plainValid = nextPlain >= 0 && nextPlain <= last;
    if (!authValid && !plainValid) break;
    checkpoint();
    if (authValid && (!plainValid || nextAuth <= nextPlain)) {
      const hit = nextAuth;
      nextAuth = image.indexOf(EFI_AUTHENTICATED_VARIABLE_GUID_BYTES, hit + 1);
      collectStoreAt(walk, hit, true);
    } else {
      const hit = nextPlain;
      nextPlain = image.indexOf(EFI_VARIABLE_GUID_BYTES, hit + 1);
      collectStoreAt(walk, hit, false);
    }
  }

  return {
    stores,
    coverage: partial ? "partial" : "complete",
    limitations,
  };
};
