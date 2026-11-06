import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { metadataToken } from "./ManagedMetadataHeaps.js";
import {
  memberListTable,
  validatedMemberListStart,
} from "./ManagedMemberPointers.js";

import {
  readTypeDefinitionRowFacts,
  type TypeDefinitionRowFacts,
} from "./ManagedTypeDefinitionRows.js";

export type MemberDefinitionTable = 4 | 6;

export interface TypeMemberListStart {
  readonly raw: number;
  readonly value: number | null;
  readonly offset: number;
}

export interface TypeMemberListRange {
  readonly start: TypeMemberListStart;
  /** Next TypeDef's validated start, or the one-past-end sentinel. */
  readonly end: number | null;
}

export interface TypeMemberListEntry {
  readonly source: TypeDefinitionRowFacts;
  readonly field: TypeMemberListRange;
  readonly method: TypeMemberListRange;
}

/** Parsed TypeDef list coordinates for one metadata-layout lifetime. */
export interface TypeMemberListFacts {
  readonly entries: readonly TypeMemberListEntry[];
  readonly issues: readonly ManagedParseIssue[];
}

export const readTypeMemberListFacts = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): TypeMemberListFacts => {
  const fields = memberListTable(layout, 4);
  const methods = memberListTable(layout, 6);
  const rows: {
    source: TypeDefinitionRowFacts;
    field: TypeMemberListStart;
    method: TypeMemberListStart;
  }[] = [];
  const issues: ManagedParseIssue[] = [];
  const types = layout.table(2);
  const typeCount = types?.rowCount ?? 0;
  // Peak retained shape includes shared scalar source facts, the parsed-start
  // and range arrays, plus each eventual JSON object/key projection. Malformed
  // row diagnostics are admitted separately before they are allocated.
  managedDecodeBudget(layout).reserve(
    typeCount * 640 + 256,
    types?.offset ?? null,
  );
  for (let row = 1; row <= typeCount; row += 1) {
    const source = readTypeDefinitionRowFacts(bytes, layout, row);
    const field = {
      offset: source.fieldListOffset,
      raw: source.fieldListRaw,
    };
    const method = {
      offset: source.methodListOffset,
      raw: source.methodListRaw,
    };
    const entry = {
      source,
      field: { ...field, value: validatedMemberListStart(field.raw, fields) },
      method: {
        ...method,
        value: validatedMemberListStart(method.raw, methods),
      },
    };
    rows.push(entry);
    for (const [name, start, table] of [
      ["FieldList", entry.field, fields],
      ["MethodList", entry.method, methods],
    ] as const)
      if (start.value === null) {
        managedDecodeBudget(layout).reserve(512, start.offset);
        issues.push({
          code: "invalid-row",
          scope: `metadata.TypeDef:${metadataToken(2, row)}`,
          offset: start.offset,
          detail: `TypeDef ${name} start ${String(start.raw)} is outside the one-based list range 1..${String((table?.rowCount ?? 0) + 1)}`,
        });
      }
  }
  const nonmonotonicFields = new Set<number>();
  const nonmonotonicMethods = new Set<number>();
  for (const [name, kind, affected] of [
    ["FieldList", "field", nonmonotonicFields],
    ["MethodList", "method", nonmonotonicMethods],
  ] as const) {
    let lastValidIndex: number | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const current = rows[index]?.[kind];
      if (current === undefined || current.value === null) continue;
      if (lastValidIndex !== null) {
        const preceding = rows[lastValidIndex]?.[kind];
        if (
          preceding !== undefined &&
          preceding.value !== null &&
          current.value < preceding.value
        ) {
          managedDecodeBudget(layout).reserve(512, current.offset);
          for (let row = lastValidIndex; row <= index; row += 1)
            affected.add(row);
          issues.push({
            code: "invalid-row",
            scope: `metadata.TypeDef:${metadataToken(2, index + 1)}`,
            offset: current.offset,
            detail: `TypeDef ${name} start ${String(current.raw)} decreases from preceding start ${String(preceding.raw)}; adjacent member ranges are unknown`,
          });
        }
      }
      lastValidIndex = index;
    }
  }
  const entries: TypeMemberListEntry[] = rows.map((entry, index) => {
    const next = rows[index + 1];
    return {
      source: entry.source,
      field: {
        start: {
          ...entry.field,
          value: nonmonotonicFields.has(index) ? null : entry.field.value,
        },
        end:
          next === undefined
            ? (fields?.rowCount ?? 0) + 1
            : nonmonotonicFields.has(index) || nonmonotonicFields.has(index + 1)
              ? null
              : next.field.value,
      },
      method: {
        start: {
          ...entry.method,
          value: nonmonotonicMethods.has(index) ? null : entry.method.value,
        },
        end:
          next === undefined
            ? (methods?.rowCount ?? 0) + 1
            : nonmonotonicMethods.has(index) ||
                nonmonotonicMethods.has(index + 1)
              ? null
              : next.method.value,
      },
    };
  });
  return { entries, issues };
};
