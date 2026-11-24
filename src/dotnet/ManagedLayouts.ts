import { BinaryReader } from "../domain/binaryContainer.js";
import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import {
  metadataRowCursor,
  metadataToken,
} from "../domain/managed/managedMetadataHeaps.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import { memberDeclaringTypeRowLookup } from "../domain/managed/managedMemberOwnership.js";
import { readManagedValue } from "../domain/managed/managedReaderFailure.js";
import type { TypeRange } from "../domain/managed/managedMemberInspectorCore.js";
import type { TypeMemberListFacts } from "../domain/managed/managedTypeMemberLists.js";
import {
  readFieldDefinitionName,
  readFieldDefinitionRow,
} from "./ManagedFieldDefinitionRows.js";
import type { SelectedTypeTokens } from "./ManagedMemberRows.js";

type LayoutDeclarations = NonNullable<
  ManagedMemberInspection["layout_declarations"]
>;
const PACKING_SIZES = new Set([0, 1, 2, 4, 8, 16, 32, 64, 128]);

/** Read declared layout coordinates only; do not compute runtime sizes or load types. */
export const parseManagedLayoutDeclarations = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  memberLists: TypeMemberListFacts,
  ranges: readonly TypeRange[],
  selected: SelectedTypeTokens,
  unreadableSelectedTypes = 0,
): LayoutDeclarations => {
  const budget = managedDecodeBudget(layout);
  const issues: ManagedParseIssue[] = [];
  const classes: LayoutDeclarations["classes"] = [];
  const fields: LayoutDeclarations["fields"] = [];
  const seenClasses = new Set<number>();
  const seenFields = new Set<number>();
  const reader = new BinaryReader(bytes, true, "managed-layout");
  const typeWidth = layout.tableIndexSize(2);
  const fieldWidth = layout.tableIndexSize(4);
  const issue = (scope: string, offset: number, detail: string) => {
    issues.push(
      admitManagedProjection(
        { code: "invalid-row", scope, offset, detail },
        budget,
      ),
    );
  };
  const duplicate = (
    seen: Set<number>,
    key: number,
    scope: string,
    offset: number,
  ) => {
    if (seen.has(key))
      issue(
        scope,
        offset,
        "Repeated layout declarations leave the declared layout ambiguous; all physical rows are retained.",
      );
    else {
      budget.reserve(128, offset);
      seen.add(key);
    }
  };
  for (let row = 1; row <= (layout.table(15)?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const start = metadataRowOffset(layout, 15, row);
      // The admitted table bounds the owner coordinate. Defer row bookkeeping
      // until selection is known; unrelated declarations retain no row facts.
      const parent =
        typeWidth === 2 ? reader.u16(start + 6) : reader.u32(start + 6);
      const source = memberLists.entries[parent - 1]?.source;
      const token = source === undefined ? null : metadataToken(2, parent);
      if (token !== null && selected !== null && !selected.has(token)) return;
      const cursor = metadataRowCursor(bytes, layout, 15, row);
      const packing = cursor.u16();
      const size = cursor.u32();
      const scope = `metadata.ClassLayout:${metadataToken(15, row)}`;
      if (source === undefined)
        issue(
          scope,
          cursor.start + 6,
          "ClassLayout.Parent does not reference an existing TypeDef row.",
        );
      else {
        duplicate(seenClasses, parent, scope, cursor.start);
        const kind = source.flags & 0x18;
        if ((source.flags & 0x20) !== 0 || (kind !== 0x08 && kind !== 0x10))
          issue(
            scope,
            cursor.start,
            "ClassLayout requires a non-interface TypeDef with SequentialLayout or ExplicitLayout.",
          );
        else if (kind === 0x10 ? packing !== 0 : !PACKING_SIZES.has(packing))
          issue(
            scope,
            cursor.start,
            "PackingSize must be zero for ExplicitLayout, or zero/a power of two through 128 for SequentialLayout.",
          );
      }
      classes.push(
        admitManagedProjection(
          {
            token: metadataToken(15, row),
            row_offset: cursor.start,
            parent_row: parent,
            type_token: token,
            type_name: ranges[parent - 1]?.fullName ?? null,
            packing_size: packing,
            class_size: size,
          },
          budget,
        ),
      );
    }, issues);
  }
  // The shared owner follows physical Field RIDs through FieldPtr when present.
  // Avoid allocating it for the common case with no FieldLayout declarations.
  const owner =
    (layout.table(16)?.rowCount ?? 0) === 0
      ? undefined
      : readManagedValue(
          () => memberDeclaringTypeRowLookup(bytes, layout, 4, memberLists),
          issues,
        );
  for (let row = 1; row <= (layout.table(16)?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const start = metadataRowOffset(layout, 16, row);
      const field =
        fieldWidth === 2 ? reader.u16(start + 4) : reader.u32(start + 4);
      const valid = field > 0 && field <= (layout.table(4)?.rowCount ?? 0);
      const parent =
        valid && owner !== undefined
          ? readManagedValue(() => owner(field), issues)
          : undefined;
      const declared =
        parent === undefined || parent === 0 ? undefined : ranges[parent - 1];
      if (
        declared !== undefined &&
        selected !== null &&
        !selected.has(declared.token)
      )
        return;
      const cursor = metadataRowCursor(bytes, layout, 16, row);
      const offset = cursor.u32();
      const scope = `metadata.FieldLayout:${metadataToken(16, row)}`;
      let name: string | null = null;
      if (!valid)
        issue(
          scope,
          cursor.start + 4,
          "FieldLayout.Field does not reference an existing physical Field row.",
        );
      else {
        duplicate(seenFields, field, scope, cursor.start);
        const definition = readFieldDefinitionRow(bytes, layout, field);
        name =
          readManagedValue(
            () => readFieldDefinitionName(bytes, layout, definition),
            issues,
          ) ?? null;
        const type =
          parent === undefined || parent === 0
            ? undefined
            : memberLists.entries[parent - 1]?.source;
        if (type === undefined)
          issue(
            scope,
            cursor.start + 4,
            "FieldLayout declaring-type ownership is unresolved.",
          );
        else if (
          (type.flags & 0x38) !== 0x10 ||
          (definition.flags & 0x10) !== 0
        )
          issue(
            scope,
            cursor.start,
            "FieldLayout requires an instance field of a non-interface ExplicitLayout type.",
          );
      }
      fields.push(
        admitManagedProjection(
          {
            token: metadataToken(16, row),
            row_offset: cursor.start,
            field_row: field,
            field_token: valid ? metadataToken(4, field) : null,
            declaring_type_token: declared?.token ?? null,
            declaring_type: declared?.fullName ?? null,
            field_name: name,
            offset_bytes: offset,
          },
          budget,
        ),
      );
    }, issues);
  }
  return {
    state:
      issues.length === 0 && unreadableSelectedTypes === 0
        ? "complete"
        : "partial",
    classes,
    fields,
    issues,
  };
};
