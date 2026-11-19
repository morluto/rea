import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import type { ManagedConstant } from "../domain/managed/managedConstant.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import {
  MANAGED_CODED_INDEXES,
  type ManagedMetadataLayout,
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

type Declaration = ManagedConstant["declarations"][number];

/** Field and Param parents; Property defaults are not decoded. */
export type ManagedConstantParentTable = 4 | 8;

/** FieldAttributes.HasDefault and ParamAttributes.HasDefault (ECMA-335 II.23.1.5, II.23.1.13). */
const OWNERS: Readonly<
  Record<ManagedConstantParentTable, { name: string; hasDefault: number }>
> = {
  4: { name: "field", hasDefault: 0x8000 },
  8: { name: "parameter", hasDefault: 0x1000 },
};

/** Index physical declarations once; only selected owners decode their blobs. */
const constantDeclarations = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): ReadonlyMap<string, Declaration[]> => {
  const result = new Map<string, Declaration[]>();
  const budget = managedDecodeBudget(layout);
  for (let row = 1; row <= (layout.table(11)?.rowCount ?? 0); row++) {
    const cursor = metadataRowCursor(bytes, layout, 11, row);
    const typeAndPadding = cursor.u16();
    const parentRaw = cursor.readIndex(layout.codedIndexSize("HasConstant"));
    const blobIndex = cursor.readIndex(layout.blobIndexSize);
    const definition = MANAGED_CODED_INDEXES.HasConstant;
    const parent = decodeMetadataCodedIndex(
      parentRaw,
      definition.bits,
      definition.tables,
      layout.rowCounts,
    );
    budget.reserveRow(11, row, cursor.start);
    if (parent.kind !== "valid") {
      budget.reserve(512, cursor.start);
      issues.push({
        code: "invalid-row",
        scope: "metadata.Constant",
        offset: cursor.start,
        detail:
          parent.kind === "invalid"
            ? parent.reason
            : "Constant parent is null.",
      });
      continue;
    }
    if (parent.table !== 4 && parent.table !== 8) continue;
    const declaration: Declaration = {
      row_offset: cursor.start,
      type_code: typeAndPadding & 255,
      padding: typeAndPadding >>> 8,
      blob_index: blobIndex,
    };
    const previous = result.get(parent.token);
    if (previous === undefined) result.set(parent.token, [declaration]);
    else previous.push(declaration);
  }
  return result;
};

/**
 * One Constant-table owner per inspection: Field and Param consumers share its
 * declaration index, and the layout budget owns decoding allocations and
 * retained values. Null means the row has neither HasDefault nor a Constant row.
 */
export type ManagedConstantReader = ((
  table: ManagedConstantParentTable,
  row: number,
  flags: number,
) => ManagedConstant | null) & {
  /**
   * Whether the row declares a default (HasDefault or a Constant row), read
   * from its flags and the declaration index alone: no blob is read, decoded
   * or charged.
   */
  readonly declares: (
    table: ManagedConstantParentTable,
    row: number,
    flags: number,
  ) => boolean;
};

export const createManagedConstantReader = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
): ManagedConstantReader => {
  let declarations: ReadonlyMap<string, Declaration[]> | undefined;
  const declarationsOf = (table: ManagedConstantParentTable, row: number) => {
    declarations ??= constantDeclarations(bytes, layout, issues);
    return declarations.get(metadataToken(table, row)) ?? [];
  };
  const declares = (
    table: ManagedConstantParentTable,
    row: number,
    flags: number,
  ): boolean =>
    declarationsOf(table, row).length > 0 ||
    (flags & OWNERS[table].hasDefault) !== 0;
  const read = (
    table: ManagedConstantParentTable,
    row: number,
    flags: number,
  ): ManagedConstant | null => {
    const token = metadataToken(table, row);
    const rows = declarationsOf(table, row);
    const owner = OWNERS[table];
    const hasDefault = (flags & owner.hasDefault) !== 0;
    if (rows.length === 0 && !hasDefault) return null;
    const budget = managedDecodeBudget(layout);
    const result: ManagedConstant = {
      state: "unavailable",
      declarations: rows,
      element_type: null,
      raw_hex: null,
      value: null,
      limitation: null,
    };
    const scope = `metadata.Constant:${token}`;
    const first = rows[0];
    const offset =
      first?.row_offset ?? metadataRowCursor(bytes, layout, table, row).start;
    try {
      if (!hasDefault || rows.length !== 1 || first === undefined)
        throw managedFailure(
          "invalid-row",
          scope,
          `A ${owner.name} default requires HasDefault and exactly one Constant row.`,
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
  return Object.assign(read, { declares });
};
