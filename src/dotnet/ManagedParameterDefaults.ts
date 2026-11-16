import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import type { ManagedConstantReader } from "./ManagedConstants.js";
import { managedDecodeBudget } from "../domain/managed/managedDecodeBudget.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import {
  metadataToken,
  readMetadataString,
} from "../domain/managed/managedMetadataHeaps.js";
import {
  memberListDefinitionRow,
  memberListListsDefinition,
  memberListTable,
  validatedMemberListStart,
} from "../domain/managed/managedMemberPointers.js";
import { readMethodParamList } from "./ManagedMethodDefinitionRows.js";
import {
  managedFailure,
  ManagedReaderFailure,
  readManagedValue,
} from "../domain/managed/managedReaderFailure.js";

type ParameterDefault = NonNullable<
  ManagedMemberInspection["methods"][number]["parameter_defaults"]
>[number];

interface ParamRuns {
  /** Validated ParamList starts by MethodDef row; zero is an invalid coordinate. */
  readonly starts: Uint32Array;
  /** Largest end of a nonempty valid run in an earlier row. */
  readonly earlierEnd: Uint32Array;
  /** Smallest start of a nonempty valid run in a later row. */
  readonly laterStart: Uint32Array;
  readonly sentinel: number;
}

/**
 * ECMA-335 II.22.26: a run continues to the next MethodDef row's ParamList, so
 * runs follow MethodDef order. A nonempty run out of order with another one
 * is contradictory rather than rescanned: accepted runs are disjoint, examined
 * positions stay bounded by the Param list, and attribution costs one pass
 * over MethodDef coordinates.
 */
const readParamRuns = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): ParamRuns => {
  const methods = layout.table(6)?.rowCount ?? 0;
  const list = memberListTable(layout, 8);
  const sentinel = (list?.rowCount ?? 0) + 1;
  managedDecodeBudget(layout).reserve(
    3 * (methods + 2) * Uint32Array.BYTES_PER_ELEMENT + 256,
    layout.table(6)?.offset ?? null,
  );
  const starts = new Uint32Array(methods + 2);
  for (let row = 1; row <= methods; row += 1)
    starts[row] =
      validatedMemberListStart(
        readMethodParamList(bytes, layout, row).raw,
        list,
      ) ?? 0;
  starts[methods + 1] = sentinel;
  const occupied = (row: number): boolean => {
    const start = starts[row] ?? 0;
    const end = starts[row + 1] ?? 0;
    return start !== 0 && end !== 0 && start < end;
  };
  const earlierEnd = new Uint32Array(methods + 2);
  for (let row = 2; row <= methods; row += 1)
    earlierEnd[row] = Math.max(
      earlierEnd[row - 1] ?? 0,
      occupied(row - 1) ? (starts[row] ?? 0) : 0,
    );
  const laterStart = new Uint32Array(methods + 2).fill(sentinel);
  for (let row = methods - 1; row >= 1; row -= 1)
    laterStart[row] = Math.min(
      laterStart[row + 1] ?? sentinel,
      occupied(row + 1) ? (starts[row + 1] ?? sentinel) : sentinel,
    );
  return { starts, earlierEnd, laterStart, sentinel };
};

/** The list positions one MethodDef owns, or the reason they are unknown. */
const attributedRun = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  runs: ParamRuns,
  row: number,
): { readonly start: number; readonly end: number } => {
  const own = readMethodParamList(bytes, layout, row);
  const start = runs.starts[row] ?? 0;
  const end = runs.starts[row + 1] ?? 0;
  const unknown = (detail: string, offset = own.offset) =>
    managedFailure(
      "invalid-row",
      `metadata.MethodDef:${metadataToken(6, row)}`,
      `${detail}; its parameter defaults are unknown`,
      offset,
    );
  const range = `the one-based list range 1..${String(runs.sentinel)}`;
  if (start === 0)
    throw unknown(
      `MethodDef ParamList start ${String(own.raw)} is outside ${range}`,
    );
  if (end === 0) {
    const next = readMethodParamList(bytes, layout, row + 1);
    throw unknown(
      `Next MethodDef ParamList start ${String(next.raw)}, which ends this run, is outside ${range}`,
      next.offset,
    );
  }
  if (end < start)
    throw unknown(
      `MethodDef ParamList run ${String(start)}..${String(end)} ends before it starts`,
    );
  if (
    start < end &&
    ((runs.earlierEnd[row] ?? 0) > start ||
      (runs.laterStart[row] ?? runs.sentinel) < end)
  )
    throw unknown(
      `MethodDef ParamList run ${String(start)}..${String(end)} is out of order with another method's nonempty run`,
    );
  return { start, end };
};

/**
 * Param columns (ECMA-335 II.22.33): Flags and Sequence, then the Name string
 * index. Layout admission bounds every row of the table, and the checked
 * reader names any range that is not.
 */
const readParamRow = (
  reader: BinaryReader,
  layout: ManagedMetadataLayout,
  row: number,
): {
  readonly offset: number;
  readonly flags: number;
  readonly sequence: number;
  readonly nameIndex: number;
} => {
  const offset = metadataRowOffset(layout, 8, row);
  return {
    offset,
    flags: reader.u16(offset),
    sequence: reader.u16(offset + 2),
    nameIndex:
      layout.stringIndexSize === 2
        ? reader.u16(offset + 4)
        : reader.u32(offset + 4),
  };
};

/**
 * ECMA-335 II.22.26: a method owns the Param list positions from its ParamList
 * start up to the next method's start. A Param row has no owning method when
 * no ParamPtr row lists it, or when its list position precedes every method's
 * run. A default on such a row could belong to any method, so no method's
 * defaults are complete. Rows without HasDefault or a Constant row cannot hide
 * a default.
 */
const unownedParameterDefault = (
  bytes: Buffer,
  reader: BinaryReader,
  layout: ManagedMetadataLayout,
  constant: ManagedConstantReader,
  runs: ParamRuns,
): ManagedReaderFailure | null => {
  const declares = (row: number, reason: string) => {
    const { offset, flags } = readParamRow(reader, layout, row);
    // Presence is enough to make every method's defaults unknown, so an
    // unowned row's value is never decoded or charged.
    return !constant.declares(8, row, flags)
      ? null
      : managedFailure(
          "invalid-row",
          `metadata.Param:${metadataToken(8, row)}`,
          `Param row declares a default, but ${reason}, so its method is unknown; parameter defaults are unknown`,
          offset,
        );
  };
  const rows = layout.table(8)?.rowCount ?? 0;
  for (let row = 1; row <= rows; row += 1) {
    if (memberListListsDefinition(bytes, layout, 8, row)) continue;
    const failure = declares(row, "no ParamPtr row lists it");
    if (failure !== null) return failure;
  }
  // Valid runs follow MethodDef order, so the smallest valid start is the
  // first position any method owns.
  let first = runs.sentinel;
  for (let row = 1; row < runs.starts.length - 1; row += 1) {
    const start = runs.starts[row] ?? 0;
    if (start !== 0 && start < first) first = start;
  }
  for (let position = 1; position < first; position += 1) {
    const failure = declares(
      memberListDefinitionRow(bytes, layout, 8, position),
      "its list position precedes every MethodDef ParamList run",
    );
    if (failure !== null) return failure;
  }
  return null;
};

/**
 * Param rows a selected method owns that declare a default, decoded by the
 * shared Constant-table owner. Rows without HasDefault or a Constant row are
 * examined but neither retained nor charged.
 */
export const createManagedParameterDefaultReader = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  issues: ManagedParseIssue[],
  constant: ManagedConstantReader,
): ((methodRow: number) => ParameterDefault[] | null) => {
  const reader = new BinaryReader(bytes, true, "managed");
  let runs: ParamRuns | undefined;
  // Undefined until the unowned-row scan runs; a clean scan caches null so the
  // Param table is scanned once per reader, not once per method.
  let unowned: ManagedReaderFailure | null | undefined;
  return (methodRow) => {
    // Without Param rows no method owns a parameter default, whatever its
    // list coordinate says.
    if ((layout.table(8)?.rowCount ?? 0) === 0) return [];
    try {
      runs ??= readParamRuns(bytes, layout);
      const { start, end } = attributedRun(bytes, layout, runs, methodRow);
      if (unowned === undefined)
        unowned = unownedParameterDefault(
          bytes,
          reader,
          layout,
          constant,
          runs,
        );
      if (unowned !== null) throw unowned;
      const defaults: ParameterDefault[] = [];
      for (let position = start; position < end; position += 1) {
        const row = memberListDefinitionRow(bytes, layout, 8, position);
        // One unreadable Param row is reported without hiding its siblings.
        const entry = readManagedValue((): ParameterDefault | null => {
          const param = readParamRow(reader, layout, row);
          const declared = constant(8, row, param.flags);
          if (declared === null) return null;
          // A retained default carries the row bookkeeping its cursor did.
          managedDecodeBudget(layout).reserveRow(8, row, param.offset);
          return {
            token: metadataToken(8, row),
            row_offset: param.offset,
            sequence: param.sequence,
            name: readMetadataString(
              bytes,
              layout,
              param.nameIndex,
              layout.strings.size,
            ),
            flags: param.flags,
            constant: declared,
          };
        }, issues);
        if (entry !== undefined && entry !== null) defaults.push(entry);
      }
      return defaults;
    } catch (cause: unknown) {
      if (
        !(cause instanceof ManagedReaderFailure) ||
        cause.issue.code === "resource-limit"
      )
        throw cause;
      issues.push(cause.issue);
      return null;
    }
  };
};
