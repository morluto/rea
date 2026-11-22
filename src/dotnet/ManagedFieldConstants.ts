import { BinaryReader } from "../domain/binaryContainer.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import type { ManagedFieldConstant } from "../domain/managed/managedFieldConstant.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import {
  MANAGED_CODED_INDEXES,
  type ManagedMetadataLayout,
  type MetadataTableLayout,
} from "../domain/managed/managedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataToken,
  readMetadataBlob,
  decodeMetadataCodedIndex,
} from "../domain/managed/managedMetadataHeaps.js";
import {
  managedFailure,
  ManagedHeapAmbiguityFailure,
  ManagedReaderFailure,
} from "../domain/managed/managedReaderFailure.js";
import {
  decodeManagedConstantValue,
  managedConstantType,
} from "./ManagedConstantValue.js";

type Declaration = ManagedFieldConstant["declarations"][number];

const readConstantRow = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
): {
  readonly cursorStart: number;
  readonly parentRaw: number;
  readonly declaration: Declaration;
} => {
  const cursor = metadataRowCursor(bytes, layout, 11, row);
  const typeAndPadding = cursor.u16();
  const parentRaw = cursor.readIndex(layout.codedIndexSize("HasConstant"));
  const blobIndex = cursor.readIndex(layout.blobIndexSize);
  return {
    cursorStart: cursor.start,
    parentRaw,
    declaration: {
      row_offset: cursor.start,
      type_code: typeAndPadding & 255,
      padding: typeAndPadding >>> 8,
      blob_index: blobIndex,
    },
  };
};

/** Index physical declarations once; only selected fields decode their blobs. */
const fieldConstantDeclarations = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): ReadonlyMap<number, Declaration[]> => {
  const result = new Map<number, Declaration[]>();
  const budget = managedDecodeBudget(layout);
  const definition = MANAGED_CODED_INDEXES.HasConstant;
  for (let row = 1; row <= (layout.table(11)?.rowCount ?? 0); row++) {
    const { cursorStart, parentRaw, declaration } = readConstantRow(
      bytes,
      layout,
      row,
    );
    const parent = decodeMetadataCodedIndex(
      parentRaw,
      definition.bits,
      definition.tables,
      layout.rowCounts,
    );
    budget.reserveRow(11, row, cursorStart);
    if (parent.kind !== "valid") {
      budget.reserve(512, cursorStart);
      issues.push({
        code: "invalid-row",
        scope: "metadata.Constant",
        offset: cursorStart,
        detail:
          parent.kind === "invalid"
            ? parent.reason
            : "Constant parent is null.",
      });
      continue;
    }
    if (parent.table !== 4) continue;
    const previous = result.get(parent.row);
    if (previous === undefined) result.set(parent.row, [declaration]);
    else previous.push(declaration);
  }
  return result;
};

/**
 * Binary-search the sorted Constant table for a selected Field row without
 * charging or decoding unrelated Constant rows. Returns null if an observed
 * inversion shows the table is not sorted by Parent, triggering linear fallback.
 */
const lookupSortedFieldConstants = ({
  bytes,
  layout,
  table,
  reader,
  parentSize,
  fieldRow,
}: {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly table: MetadataTableLayout;
  readonly reader: BinaryReader;
  readonly parentSize: 2 | 4;
  readonly fieldRow: number;
}): Declaration[] | null => {
  if (table.rowCount === 0 || fieldRow < 1) return [];
  const readParentRaw = (constantRow: number): number => {
    const offset = table.offset + (constantRow - 1) * table.rowSize + 2;
    return parentSize === 2 ? reader.u16(offset) : reader.u32(offset);
  };
  // Field is tag 0 in HasConstant (bits = 2, tables = [4, 8, 23]).
  const targetParentRaw = fieldRow * 4;
  let lo = 1;
  let hi = table.rowCount;
  let loVal = readParentRaw(lo);
  let hiVal = lo === hi ? loVal : readParentRaw(hi);
  if (loVal > hiVal) return null;
  if (targetParentRaw < loVal || targetParentRaw > hiVal) return [];
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midVal = mid === lo ? loVal : readParentRaw(mid);
    if (midVal < loVal || midVal > hiVal) return null;
    if (midVal < targetParentRaw) {
      lo = mid + 1;
      const nextLoVal = lo === hi ? hiVal : readParentRaw(lo);
      if (nextLoVal < midVal || nextLoVal > hiVal) return null;
      loVal = nextLoVal;
    } else {
      hi = mid;
      hiVal = midVal;
    }
  }
  if (loVal !== targetParentRaw) return [];
  const matches: Declaration[] = [];
  for (let constantRow = lo; constantRow <= table.rowCount; constantRow += 1) {
    const val = constantRow === lo ? loVal : readParentRaw(constantRow);
    if (val < targetParentRaw) return null;
    if (val > targetParentRaw) break;
    matches.push(readConstantRow(bytes, layout, constantRow).declaration);
  }
  return matches;
};

/** The shared metadata budget owns both decoding allocations and retained values. */
export const createManagedFieldConstantReader = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
  { selected = false }: { readonly selected?: boolean } = {},
): ((row: number, flags: number) => ManagedFieldConstant | null) => {
  let declarations: ReadonlyMap<number, Declaration[]> | undefined;
  let constantReader: BinaryReader | undefined;
  const constantTable = layout.table(11);
  const parentSize = layout.codedIndexSize("HasConstant");
  const fieldRows = (row: number): Declaration[] => {
    if (!selected || declarations !== undefined) {
      declarations ??= fieldConstantDeclarations(bytes, layout, issues);
      return declarations.get(row) ?? [];
    }
    if (constantTable === undefined || constantTable.rowCount === 0) return [];
    constantReader ??= new BinaryReader(
      bytes,
      true,
      "managed-metadata-constants",
    );
    const matched = lookupSortedFieldConstants({
      bytes,
      layout,
      table: constantTable,
      reader: constantReader,
      parentSize,
      fieldRow: row,
    });
    if (matched !== null) return matched;
    declarations = fieldConstantDeclarations(bytes, layout, issues);
    return declarations.get(row) ?? [];
  };
  return (row, flags) => {
    const rows = fieldRows(row);
    const hasDefault = (flags & 0x8000) !== 0;
    if (rows.length === 0 && !hasDefault) return null;
    const budget = managedDecodeBudget(layout);
    const result: ManagedFieldConstant = {
      state: "unavailable",
      declarations: rows,
      element_type: null,
      raw_hex: null,
      value: null,
      limitation: null,
    };
    const scope = `metadata.Constant:${metadataToken(4, row)}`;
    const first = rows[0];
    const offset =
      first?.row_offset ?? metadataRowCursor(bytes, layout, 4, row).start;
    try {
      if (!hasDefault || rows.length !== 1 || first === undefined)
        throw managedFailure(
          "invalid-row",
          scope,
          "A field default requires HasDefault and exactly one Constant row.",
          offset,
        );
      if (first.padding !== 0)
        throw managedFailure(
          "invalid-row",
          scope,
          "Constant row padding must be zero.",
          offset,
        );
      const value = readMetadataBlob(bytes, layout, first.blob_index);
      budget.admitTransient(value.length * 8 + 1024, offset);
      result.raw_hex = value.toString("hex");
      result.element_type = managedConstantType(first.type_code);
      result.value = decodeManagedConstantValue(
        first.type_code,
        value,
        scope,
        offset,
      );
      result.state = "decoded";
    } catch (cause: unknown) {
      if (
        !(cause instanceof ManagedReaderFailure) ||
        cause.issue.code === "resource-limit"
      )
        throw cause;
      if (!(cause instanceof ManagedHeapAmbiguityFailure))
        issues.push(cause.issue);
      result.limitation = cause.issue.detail;
    } finally {
      budget.releaseTransient();
    }
    return admitManagedProjection(result, budget);
  };
};
