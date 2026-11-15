import { BinaryReader } from "../binaryContainer.js";
import { managedDecodeBudget } from "./managedDecodeBudget.js";
import type {
  ManagedMetadataLayout,
  MetadataTableLayout,
} from "./managedMetadataLayout.js";
import {
  managedFailure,
  ManagedReaderFailure,
} from "./managedReaderFailure.js";

/** Field, MethodDef and Param rows; each pointer table precedes its definition table. */
type MemberTable = 4 | 6 | 8;
type ListRowLookup = (definitionRow: number) => number;
/** Pointer positions by definition row (zero when unlisted) and their lookup. */
interface MemberListIndex {
  readonly positions: Uint32Array;
  readonly lookup: ListRowLookup;
}
const lookups = new WeakMap<
  ManagedMetadataLayout,
  Map<MemberTable, MemberListIndex | ManagedReaderFailure>
>();

/** TypeDef and MethodDef list coordinates refer to the nonempty pointer table when present. */
export const memberListTable = (
  layout: ManagedMetadataLayout,
  table: MemberTable,
) => {
  const pointers = layout.table(table - 1);
  return pointers !== undefined && pointers.rowCount > 0
    ? pointers
    : layout.table(table);
};

/** List columns must accommodate either physical definition or pointer rows. */
export const memberListIndexSize = (
  layout: ManagedMetadataLayout,
  table: MemberTable,
): 2 | 4 =>
  layout.tableIndexSize(table - 1) === 4 || layout.tableIndexSize(table) === 4
    ? 4
    : 2;

/** Normalize a TypeDef list coordinate once for parsing and owner lookup. */
export const validatedMemberListStart = (
  start: number,
  table: MetadataTableLayout | undefined,
): number | null => {
  const total = table?.rowCount ?? 0;
  return Number.isSafeInteger(start) && start >= 1 && start <= total + 1
    ? start
    : null;
};

/** Validate a nonempty pointer table once and index its definition rows. */
const memberListIndex = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
): MemberListIndex | undefined => {
  const pointers = layout.table(table - 1);
  if (pointers === undefined || pointers.rowCount === 0) return undefined;
  let byTable = lookups.get(layout);
  const cached = byTable?.get(table);
  if (cached instanceof ManagedReaderFailure) throw cached;
  if (cached !== undefined) return cached;

  const definitionCount = layout.table(table)?.rowCount ?? 0;
  // The layout already admitted the source table extent. Reserve retained index
  // storage and its fixed bookkeeping before allocating either container.
  managedDecodeBudget(layout).reserve(
    (definitionCount + 1) * Uint32Array.BYTES_PER_ELEMENT + 256,
    pointers.offset,
  );
  if (byTable === undefined) {
    byTable = new Map();
    lookups.set(layout, byTable);
  }
  const positions = new Uint32Array(definitionCount + 1);
  try {
    const width = layout.tableIndexSize(table);
    for (let row = 1; row <= pointers.rowCount; row += 1) {
      const offset: number = pointers.offset + (row - 1) * pointers.rowSize;
      const definition =
        width === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset);
      if (definition === 0 || definition > definitionCount)
        throw managedFailure(
          "invalid-row",
          `metadata.${pointers.name}`,
          `Pointer row ${String(row)} names an out-of-range definition row ${String(definition)}`,
          offset,
        );
      if (positions[definition] !== 0)
        throw managedFailure(
          "invalid-row",
          `metadata.${pointers.name}`,
          `Definition row ${String(definition)} has more than one pointer row; its declaring type is ambiguous`,
          offset,
        );
      positions[definition] = row;
    }
    const lookup: ListRowLookup = (definition) => {
      const position = positions[definition] ?? 0;
      if (position === 0)
        throw managedFailure(
          "invalid-row",
          `metadata.${pointers.name}`,
          `Definition row ${String(definition)} has no pointer row identifying its declaring type`,
          pointers.offset,
        );
      return position;
    };
    const index = { positions, lookup };
    byTable.set(table, index);
    return index;
  } catch (cause: unknown) {
    // Invalid metadata must not rebuild and charge the same retained index for
    // every attribute/member that asks for its owner.
    if (cause instanceof ManagedReaderFailure) byTable.set(table, cause);
    throw cause;
  }
};

/** Resolve physical definition rows to list positions without changing token identity. */
export const memberListRowLookup = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
): ListRowLookup =>
  memberListIndex(bytes, layout, table)?.lookup ?? ((row) => row);

/**
 * Whether some pointer row lists this definition row. Without a pointer table
 * every row is listed; an unlisted row has no owning list run.
 */
export const memberListListsDefinition = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
  definitionRow: number,
): boolean => {
  const index = memberListIndex(bytes, layout, table);
  return index === undefined || (index.positions[definitionRow] ?? 0) !== 0;
};

/** Resolve a validated list position to its physical definition row. */
export const memberListDefinitionRow = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
  position: number,
): number => {
  const pointers = layout.table(table - 1);
  if (pointers === undefined || pointers.rowCount === 0) return position;
  // The index validates every pointer row once and replays its failure.
  memberListIndex(bytes, layout, table);
  const offset = pointers.offset + (position - 1) * pointers.rowSize;
  const reader = new BinaryReader(bytes, true, "managed");
  return layout.tableIndexSize(table) === 2
    ? reader.u16(offset)
    : reader.u32(offset);
};
