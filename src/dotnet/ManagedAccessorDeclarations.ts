import { BinaryReader } from "../domain/binaryContainer.js";
import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
  ManagedRepresentationFailure,
} from "../domain/managed/managedDecodeBudget.js";
import {
  decodeMetadataCodedIndex,
  metadataRowCursor,
  metadataToken,
  readMetadataString,
} from "../domain/managed/managedMetadataHeaps.js";
import {
  MANAGED_CODED_INDEXES,
  type ManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import {
  managedFailure,
  readManagedValue,
} from "../domain/managed/managedReaderFailure.js";

type Accessors = NonNullable<ManagedMemberInspection["accessors"]>;
type Declaration = Accessors["declarations"][number];
type AccessorMembers = Pick<
  ManagedMemberInspection,
  "methods" | "unresolved_definitions"
>;
const ROLES = [
  [1, "setter"],
  [2, "getter"],
  [4, "other"],
  [8, "adder"],
  [16, "remover"],
  [32, "raiser"],
] as const;

const readDeclarations = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  report: AccessorMembers,
): Accessors => {
  const budget = managedDecodeBudget(layout);
  const declarations: Declaration[] = [];
  const issues: ManagedParseIssue[] = [];
  const completeNames = (report.unresolved_definitions?.rows.length ?? 0) === 0;
  const table = layout.table(24);
  if (report.methods.length === 0 || (table?.rowCount ?? 0) === 0)
    return {
      state: completeNames ? "complete" : "partial",
      declarations,
      issues,
    };
  budget.admitTransient(report.methods.length * 96, null);
  const methods = new Map(
    report.methods.map((method) => [method.token, method]),
  );
  const methodCount = layout.table(6)?.rowCount ?? 0;
  const methodWidth = layout.tableIndexSize(6);
  const reader = new BinaryReader(bytes, true, "managed-accessors");
  const associations = new Map<
    string,
    { rowOffset: number; flags: number; name: string | null }
  >();
  const addIssue = (issue: ManagedParseIssue): void => {
    issues.push(admitManagedProjection(issue, budget));
  };
  try {
    for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
      const offset = table!.offset + (row - 1) * table!.rowSize;
      // The admitted table bounds this prefix. Skip unselected rows before reserving
      // a decoded record or following their property/event heap references.
      const methodRaw =
        methodWidth === 2 ? reader.u16(offset + 2) : reader.u32(offset + 2);
      if (methodRaw < 1 || methodRaw > methodCount) {
        addIssue({
          code: "invalid-row",
          scope: `metadata.MethodSemantics:${metadataToken(24, row)}`,
          offset: offset + 2,
          detail: `MethodSemantics Method row ${String(methodRaw)} is outside the MethodDef table; its selected-method membership is unknown`,
        });
        continue;
      }
      const method = methods.get(metadataToken(6, methodRaw));
      if (method === undefined) continue;
      const cursor = metadataRowCursor(bytes, layout, 24, row);
      const flags = cursor.u16();
      cursor.readIndex(methodWidth);
      const associationOffset = cursor.offset;
      const associationRaw = cursor.readIndex(
        layout.codedIndexSize("HasSemantics"),
      );
      const association = decodeMetadataCodedIndex(
        associationRaw,
        MANAGED_CODED_INDEXES.HasSemantics.bits,
        MANAGED_CODED_INDEXES.HasSemantics.tables,
        layout.rowCounts,
      );
      if (flags === 0 || (flags & ~0x3f) !== 0)
        addIssue({
          code: "invalid-row",
          scope: `metadata.MethodSemantics:${metadataToken(24, row)}`,
          offset,
          detail: `MethodSemantics flags 0x${flags.toString(16)} contain no recognized role or unknown bits; raw flags are retained`,
        });
      let associationRowOffset: number | null = null;
      let associationName: string | null = null;
      let associationFlags: number | null = null;
      if (association.kind === "valid") {
        let facts = associations.get(association.token);
        if (facts === undefined) {
          // Reserve the cache entry before following the heap reference. Even
          // malformed names are a single physical-row observation.
          budget.admitTransient(128, associationOffset);
          const target = metadataRowCursor(
            bytes,
            layout,
            association.table,
            association.row,
          );
          const rowOffset = target.start;
          const targetFlags = target.u16();
          const nameOffset = target.offset;
          const nameIndex = target.readIndex(layout.stringIndexSize);
          const failures: ManagedParseIssue[] = [];
          const name =
            readManagedValue(() => {
              const value = readMetadataString(bytes, layout, nameIndex);
              if (value.length === 0)
                throw managedFailure(
                  "invalid-row",
                  `metadata.${association.table === 23 ? "Property" : "Event"}:${association.token}`,
                  "Accessor association Name must reference a nonempty string",
                  nameOffset,
                );
              return value;
            }, failures) ?? null;
          for (const failure of failures) addIssue(failure);
          facts = { rowOffset, flags: targetFlags, name };
          associations.set(association.token, facts);
        }
        associationRowOffset = facts.rowOffset;
        associationFlags = facts.flags;
        associationName = facts.name;
      } else {
        addIssue({
          code: "invalid-row",
          scope: `metadata.MethodSemantics:${metadataToken(24, row)}`,
          offset: associationOffset,
          detail: `MethodSemantics Association coded index 0x${associationRaw.toString(16)} does not identify a Property or Event row: ${association.kind === "null" ? "null index" : association.reason}`,
        });
      }
      declarations.push(
        admitManagedProjection(
          {
            token: metadataToken(24, row),
            row_offset: offset,
            semantics_flags: flags,
            roles: ROLES.filter(([bit]) => (flags & bit) !== 0).map(
              ([, role]) => role,
            ),
            method_token: method.token,
            method_name: method.name,
            method_declaring_type_token: method.declaring_type_token,
            method_declaring_type: method.declaring_type,
            association_raw: associationRaw,
            association_kind:
              association.kind !== "valid"
                ? "unknown"
                : association.table === 23
                  ? "property"
                  : "event",
            association_token:
              association.kind === "valid" ? association.token : null,
            association_row_offset: associationRowOffset,
            association_name: associationName,
            association_flags: associationFlags,
          },
          budget,
        ),
      );
    }
    return {
      state: completeNames && issues.length === 0 ? "complete" : "partial",
      declarations,
      issues,
    };
  } finally {
    budget.releaseTransient();
  }
};

/** Read an independently bounded facet after original members and literals were admitted. */
export const readManagedAccessorDeclarations = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  report: AccessorMembers,
): Accessors | null => {
  const budget = managedDecodeBudget(layout);
  let recovery: Accessors;
  try {
    recovery = admitManagedProjection(
      {
        state: "partial",
        declarations: [],
        issues: [
          {
            ...new ManagedRepresentationFailure(
              Number.MAX_SAFE_INTEGER,
              budget.maximumBytes,
            ).issue,
            scope: "metadata.MethodSemantics",
          },
        ],
      },
      budget,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedRepresentationFailure)) throw cause;
    return null;
  }
  try {
    return admitManagedProjection(
      readDeclarations(bytes, layout, report),
      budget,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedRepresentationFailure)) throw cause;
    return {
      ...recovery,
      issues: [{ ...recovery.issues[0]!, offset: cause.issue.offset }],
    };
  }
};
