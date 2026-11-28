import { Budget } from "../domain/budget.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { formatGuidLittleEndian, guidBytesLittleEndian } from "./UefiGuid.js";
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

/** `VARIABLE_STORE_HEADER`: Signature, Size, Format, State, Reserved, Reserved1. */
const VARIABLE_STORE_HEADER_BYTES = 28;
const STORE_HEADER_FIELD = { size: 16, format: 20, state: 21 } as const;

/** Field offsets shared by both variable header forms (VariableFormat.h). */
const VARIABLE_HEADER_FIELD = { startId: 0, state: 2, attributes: 4 } as const;

/**
 * The two variable header layouts. The store signature selects one: an
 * authenticated store inserts MonotonicCount, TimeStamp and PubKeyIndex
 * before NameSize, so every later field moves by 28 bytes.
 */
const VARIABLE_HEADER_LAYOUT = {
  /** `VARIABLE_HEADER`. */
  plain: { nameSize: 8, dataSize: 12, vendorGuid: 16, bytes: 32 },
  /** `AUTHENTICATED_VARIABLE_HEADER`. */
  authenticated: { nameSize: 36, dataSize: 40, vendorGuid: 44, bytes: 60 },
} as const;
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

const EFI_VARIABLE_GUID_BYTES = guidBytesLittleEndian(EFI_VARIABLE_GUID);
const EFI_AUTHENTICATED_VARIABLE_GUID_BYTES = guidBytesLittleEndian(
  EFI_AUTHENTICATED_VARIABLE_GUID,
);

/**
 * EDK2 `gEdkiiWorkingBlockSignatureGuid` (SystemNvDataGuid.h): the
 * fault-tolerant-write working block that sits beside the variable store.
 */
const EDKII_WORKING_BLOCK_SIGNATURE_GUID =
  "9e58292b-7c68-497d-a0ce-6500fd9f1b95";
const EDKII_WORKING_BLOCK_SIGNATURE_BYTES = guidBytesLittleEndian(
  EDKII_WORKING_BLOCK_SIGNATURE_GUID,
);
/** `EFI_FAULT_TOLERANT_WORKING_BLOCK_HEADER`: Signature, Crc, flags, Reserved3[3], WriteQueueSize. */
const FTW_WORKING_BLOCK_HEADER_BYTES = 32;
/** Signature matches reported individually before the rest are counted. */
const REPORTED_SIGNATURE_MATCHES = 8;

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
  /**
   * Store signatures outside every reported store whose header lacks the
   * formatted marker or a header-sized extent. Such a match may be a damaged
   * store or only the GUID constant inside a driver, so a scan with matches
   * here has not established that no store exists.
   */
  readonly rejectedSignatures: number;
  /**
   * True when the image was fully searched, every candidate was examined, and
   * no EDK2 store was found. False when the search stopped early or only
   * rejected signatures were seen, so absence has not been established.
   */
  readonly absent: boolean;
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
  const layout =
    VARIABLE_HEADER_LAYOUT[authenticated ? "authenticated" : "plain"];
  const headerBytes = layout.bytes;
  if (offset + 2 > storeEnd) return { kind: "end" };
  const startId = reader.u16(offset + VARIABLE_HEADER_FIELD.startId);
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

  const stateRaw = reader.u8(offset + VARIABLE_HEADER_FIELD.state);
  const attributes = reader.u32(offset + VARIABLE_HEADER_FIELD.attributes);
  const nameSize = reader.u32(offset + layout.nameSize);
  const dataSize = reader.u32(offset + layout.dataSize);
  const vendorGuid = formatGuidLittleEndian(
    reader.bytes,
    offset + layout.vendorGuid,
  );
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
  readonly noteRejected: (detail: string) => void;
  /** A fact about how to read a reported store; coverage is unaffected. */
  readonly noteCaveat: (detail: string) => void;
  stop: boolean;
}

/**
 * Facts about how to read a store that do not change its coverage. EDK2
 * GetVariableStoreStatus treats a formatted store that is not healthy as
 * invalid, while UEFITool still walks it, so its variables are reported with
 * EDK2's verdict rather than hidden. HEADER_ALIGN aligns the mapped address,
 * which equals the image offset only when the image maps at an aligned base.
 */
const storeCaveats = (offset: number, storeState: number): string[] => [
  ...(storeState === VARIABLE_STORE_HEALTHY
    ? []
    : [
        `EDK2 store at 0x${offset.toString(16)} has State 0x${storeState.toString(16)}, not HEALTHY (0xfe); EDK2 treats this store as invalid and would not read its variables.`,
      ]),
  ...(offset % HEADER_ALIGNMENT === 0
    ? []
    : [
        `EDK2 store at 0x${offset.toString(16)} is not ${HEADER_ALIGNMENT}-byte aligned; variable positions assume HEADER_ALIGN applies to image offsets.`,
      ]),
];

/**
 * Walk the variable headers of one admitted store. The walk ends at the
 * first erased StartId, at the first invalid header, or at the store end;
 * `claimedEnd` covers only bytes it examined and accepted, so a later store
 * signature after damage is still inspected.
 */
const walkStoreVariables = (
  walk: Edk2StoreWalk,
  offset: number,
  storeEnd: number,
  authenticated: boolean,
): { readonly variables: Edk2NvramVariable[]; readonly claimedEnd: number } => {
  const { reader, checkpoint, records, nameBytes, noteOmission } = walk;
  const image = reader.bytes;
  const variables: Edk2NvramVariable[] = [];
  let cursor = offset + VARIABLE_STORE_HEADER_BYTES;
  let claimedEnd = cursor;
  while (cursor < storeEnd) {
    checkpoint();
    if (cursor + 2 > storeEnd) {
      if (isErasedRange(image, cursor, storeEnd, checkpoint))
        claimedEnd = storeEnd;
      else
        noteOmission(
          `EDK2 store at 0x${offset.toString(16)} has a non-erased one-byte suffix at 0x${cursor.toString(16)}.`,
        );
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
      if (isErasedRange(image, cursor, storeEnd, checkpoint))
        claimedEnd = storeEnd;
      else {
        noteOmission(
          `EDK2 store at 0x${offset.toString(16)} has a non-erased suffix after 0xffff at 0x${cursor.toString(16)}.`,
        );
        claimedEnd = Math.max(claimedEnd, cursor + 2);
      }
      break;
    }
    if (parsed.kind === "end") break;
    if (parsed.kind === "invalid") {
      noteOmission(parsed.detail);
      break;
    }
    if (parsed.limitation !== null) noteOmission(parsed.limitation);
    variables.push(parsed.variable);
    claimedEnd = Math.max(claimedEnd, parsed.variable.endOffset);
    cursor = parsed.variable.endOffset;
  }
  return { variables, claimedEnd };
};

const collectStoreAt = (
  walk: Edk2StoreWalk,
  offset: number,
  authenticated: boolean,
): void => {
  const { reader, checkpoint, records, occupied, stores, noteOmission } = walk;
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
  // A signature inside an already-claimed store extent is variable data.
  if (
    rangeOccupied(occupied, {
      start: offset,
      end: offset + VARIABLE_STORE_HEADER_BYTES,
    })
  )
    return;
  const storeFormat = reader.u8(offset + STORE_HEADER_FIELD.format);
  const storeState = reader.u8(offset + STORE_HEADER_FIELD.state);
  const declaredSize = reader.u32(offset + STORE_HEADER_FIELD.size);
  // Without the formatted marker and a header-sized extent this is not a
  // store header, for example a GUID constant inside a driver.
  if (
    storeFormat !== VARIABLE_STORE_FORMATTED ||
    declaredSize < VARIABLE_STORE_HEADER_BYTES
  ) {
    walk.noteRejected(
      `EDK2 ${authenticated ? "gEfiAuthenticatedVariableGuid" : "gEfiVariableGuid"} signature at 0x${offset.toString(16)} is not a formatted variable-store header (Format 0x${storeFormat.toString(16)}, Size 0x${declaredSize.toString(16)}); its bytes were not walked as variables.`,
    );
    return;
  }
  const storeGuid = formatGuidLittleEndian(image, offset);
  if (storeGuid === null) return;
  if (stores.length >= walk.maxStores) {
    noteOmission(
      `Stopped after ${walk.maxStores} EDK2 variable stores; additional stores exist.`,
    );
    walk.stop = true;
    return;
  }

  const available = image.length - offset;
  const storeEnd = offset + Math.min(declaredSize, available);
  for (const caveat of storeCaveats(offset, storeState))
    walk.noteCaveat(caveat);
  if (declaredSize > available)
    noteOmission(
      `EDK2 store at 0x${offset.toString(16)} declares size 0x${declaredSize.toString(16)} but only 0x${available.toString(16)} bytes remain; reporting readable extent.`,
    );
  const { variables, claimedEnd } = walkStoreVariables(
    walk,
    offset,
    storeEnd,
    authenticated,
  );

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

/**
 * Report each EDK2 fault-tolerant-write working block whose write queue is in
 * use. FTW is how EDK2 reclaims a full store: an interrupted reclaim leaves
 * live variables in the FTW spare area, which REA does not reconstruct, so
 * the reported store may be the stale copy. An erased queue means no write
 * was recorded and needs no caveat. The header filter follows
 * FtwInitWorkSpaceHeader, which fills the header with 0xff before writing it,
 * so a bare GUID constant inside a driver is not mistaken for a working block.
 */
const noteFaultTolerantWriteQueues = (
  reader: BinaryReader,
  checkpoint: () => void,
  note: (detail: string) => void,
): void => {
  const image = reader.bytes;
  let reported = 0;
  for (
    let hit = image.indexOf(EDKII_WORKING_BLOCK_SIGNATURE_BYTES, 0);
    hit >= 0 && reported < REPORTED_SIGNATURE_MATCHES;
    hit = image.indexOf(EDKII_WORKING_BLOCK_SIGNATURE_BYTES, hit + 1)
  ) {
    checkpoint();
    const queueStart = hit + FTW_WORKING_BLOCK_HEADER_BYTES;
    if (queueStart >= image.length) break;
    const flags = reader.u8(hit + 20);
    const reservedErased =
      (flags & 0xfc) === 0xfc &&
      reader.u8(hit + 21) === 0xff &&
      reader.u8(hit + 22) === 0xff &&
      reader.u8(hit + 23) === 0xff;
    // UINT64 WriteQueueSize; BinaryReader reads 64-bit fields signed.
    const queueSize = BigInt.asUintN(64, reader.i64(hit + 24));
    if (
      !reservedErased ||
      queueSize === 0n ||
      queueSize > BigInt(image.length - queueStart)
    )
      continue;
    if (image[queueStart] === 0xff) continue;
    reported += 1;
    note(
      `EDK2 fault-tolerant-write working block at 0x${hit.toString(16)} holds write records. REA does not replay them or reconstruct a store from the FTW spare area, so a store interrupted mid-reclaim may be reported from its stale copy.`,
    );
  }
};

/** Scan a raw image for EDK2 / OVMF `VARIABLE_STORE_HEADER` regions. */
export const scanEdk2VariableStores = (
  image: Buffer,
  maxStores: number,
  checkpoint: () => void = () => {},
  records: Budget = new Budget(UEFI_FIRMWARE_LIMITS.scanRecords),
): Edk2NvramScan => {
  const stores: Edk2NvramStore[] = [];
  const limitations: string[] = [];
  let partial = false;
  let rejectedSignatures = 0;
  const keep = (detail: string): void => {
    if (limitations.length < UEFI_FIRMWARE_LIMITS.limitationLines)
      limitations.push(detail);
  };
  const reader = new BinaryReader(image, true, "EDK2 variable store");
  const walk: Edk2StoreWalk = {
    reader,
    maxStores,
    checkpoint,
    records,
    nameBytes: new Budget(UEFI_FIRMWARE_LIMITS.decodedBytes),
    occupied: [],
    stores,
    noteOmission: (detail) => {
      partial = true;
      keep(detail);
    },
    // Not an omission: the header was examined and is not a usable store.
    noteRejected: (detail) => {
      rejectedSignatures += 1;
      if (rejectedSignatures <= REPORTED_SIGNATURE_MATCHES) keep(detail);
    },
    noteCaveat: keep,
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

  if (rejectedSignatures > REPORTED_SIGNATURE_MATCHES)
    keep(
      `${rejectedSignatures - REPORTED_SIGNATURE_MATCHES} further EDK2 store signatures are not formatted variable-store headers.`,
    );
  noteFaultTolerantWriteQueues(reader, checkpoint, keep);

  return {
    stores,
    coverage: partial ? "partial" : "complete",
    limitations,
    rejectedSignatures,
    absent: stores.length === 0 && !partial && rejectedSignatures === 0,
  };
};
