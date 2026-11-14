import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import type { ManagedConstantReader } from "./ManagedConstants.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataToken,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import {
  memberListDefinitionRow,
  memberListTable,
  validatedMemberListStart,
} from "./ManagedMemberPointers.js";
import { readMethodParamList } from "./ManagedMethodDefinitionRows.js";
import {
  managedFailure,
  ManagedReaderFailure,
} from "./ManagedReaderFailure.js";

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
  let runs: ParamRuns | undefined;
  return (methodRow) => {
    // Without Param rows no method owns a parameter default, whatever its
    // list coordinate says.
    if ((layout.table(8)?.rowCount ?? 0) === 0) return [];
    try {
      runs ??= readParamRuns(bytes, layout);
      const { start, end } = attributedRun(bytes, layout, runs, methodRow);
      const defaults: ParameterDefault[] = [];
      for (let position = start; position < end; position += 1) {
        const row = memberListDefinitionRow(bytes, layout, 8, position);
        const flags = bytes.readUInt16LE(metadataRowOffset(layout, 8, row));
        const declared = constant(8, row, flags);
        if (declared === null) continue;
        const cursor = metadataRowCursor(bytes, layout, 8, row);
        cursor.readUInt16();
        const sequence = cursor.readUInt16();
        defaults.push({
          token: metadataToken(8, row),
          row_offset: cursor.start,
          sequence,
          name: readMetadataString(
            bytes,
            layout,
            cursor.readIndex(layout.stringIndexSize),
            layout.strings.size,
          ),
          flags,
          constant: declared,
        });
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
