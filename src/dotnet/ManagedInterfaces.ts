import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "../domain/managed/managedArtifact.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import {
  decodeMetadataCodedIndex,
  metadataRowCursor,
  metadataToken,
} from "../domain/managed/managedMetadataHeaps.js";
import {
  MANAGED_CODED_INDEXES,
  type ManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import { readManagedValue } from "../domain/managed/managedReaderFailure.js";
import type {
  parseTypes,
  TypeRange,
} from "../domain/managed/managedMemberInspectorCore.js";
import { managedSignatureTypeNames } from "../domain/managed/managedSignatureTypeNames.js";
import { managedTypeReferences } from "../domain/managed/managedTypeReferences.js";
import { typeNameLookup } from "./ManagedTypeNames.js";
import type { SelectedTypeTokens } from "./ManagedMemberRows.js";
import { readTypeDefinitionRowFacts } from "../domain/managed/managedTypeDefinitionRows.js";

type InterfaceInventory = NonNullable<
  ManagedMemberInspection["interface_implementations"]
>;

/** Read explicit InterfaceImpl declarations without loading or binding their target types. */
export const parseManagedInterfaceImplementations = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  parsedTypes: Pick<ReturnType<typeof parseTypes>, "types" | "nesting">,
  selected: SelectedTypeTokens,
  unreadableSelectedTypes = 0,
): InterfaceInventory => {
  const issues: ManagedParseIssue[] = [];
  const rows: InterfaceInventory["rows"] = [];
  const budget = managedDecodeBudget(layout);
  const count = layout.table(9)?.rowCount ?? 0;
  const typeCount = layout.table(2)?.rowCount ?? 0;
  const seen = new Set<string>();
  let names: ReturnType<typeof typeNameLookup> | undefined;
  const typeName = (
    reference: Parameters<ReturnType<typeof typeNameLookup>["name"]>[0],
  ) => {
    if (names === undefined) {
      // Names share the existing metadata owners, but their failures belong to
      // this inventory rather than previously admitted method/field coverage.
      const references = managedTypeReferences(bytes, layout, issues);
      let signatures: ReturnType<typeof managedSignatureTypeNames> | undefined;
      names = typeNameLookup(
        bytes,
        layout,
        ranges,
        issues,
        references,
        (operand) => {
          // Only a TypeSpec signature needs the assembly-wide name index.
          signatures ??= managedSignatureTypeNames(
            layout,
            issues,
            parsedTypes,
            references,
          );
          return signatures.operand(operand);
        },
      );
    }
    return names.name(reference);
  };
  for (let row = 1; row <= count; row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 9, row);
      const classRow = cursor.readIndex(layout.tableIndexSize(2));
      const classValid = classRow > 0 && classRow <= typeCount;
      const classToken = classValid ? metadataToken(2, classRow) : null;
      // An invalid owner can belong to the requested selection; retain the row
      // and uncertainty instead of silently treating it as an excluded type.
      if (classToken !== null && selected !== null && !selected.has(classToken))
        return;
      const interfaceOffset = cursor.offset;
      const interfaceRaw = cursor.readIndex(
        layout.codedIndexSize("TypeDefOrRef"),
      );
      const token = metadataToken(9, row);
      const scope = `metadata.InterfaceImpl:${token}`;
      const issue = (detail: string, offset: number): void => {
        issues.push(
          admitManagedProjection(
            { code: "invalid-row", scope, offset, detail },
            budget,
          ),
        );
      };
      if (!classValid)
        issue(
          `InterfaceImpl Class must reference an existing TypeDef row; observed ${classRow}`,
          cursor.start,
        );
      const declaringType = classValid
        ? (ranges[classRow - 1]?.fullName ?? null)
        : null;
      if (classValid && declaringType === null)
        issue(
          "InterfaceImpl Class has an unreadable TypeDef name; its row coordinate is retained",
          cursor.start,
        );
      const implemented = decodeMetadataCodedIndex(
        interfaceRaw,
        MANAGED_CODED_INDEXES.TypeDefOrRef.bits,
        MANAGED_CODED_INDEXES.TypeDefOrRef.tables,
        layout.rowCounts,
      );
      if (implemented.kind !== "valid")
        issue(
          `InterfaceImpl Interface must reference an existing TypeDef, TypeRef or TypeSpec; observed 0x${interfaceRaw.toString(16)}`,
          interfaceOffset,
        );
      const duplicateKey = `${classRow}:${interfaceRaw}`;
      if (classValid && implemented.kind === "valid") {
        if (seen.has(duplicateKey))
          issue(
            "Duplicate Class and Interface declaration; the original rows are retained",
            cursor.start,
          );
        else {
          budget.reserve(128, cursor.start);
          seen.add(duplicateKey);
        }
        if (implemented.table === 2) {
          const declared = readTypeDefinitionRowFacts(
            bytes,
            layout,
            implemented.row,
          );
          if ((declared.flags & 0x20) === 0)
            issue(
              "InterfaceImpl Interface references a local TypeDef without the Interface flag",
              interfaceOffset,
            );
        }
      }
      rows.push(
        admitManagedProjection(
          {
            token,
            row_offset: cursor.start,
            class_row: classRow,
            class_token: classToken,
            declaring_type: declaringType,
            interface_coded_index: interfaceRaw,
            interface_token:
              implemented.kind === "valid" ? implemented.token : null,
            interface_name:
              implemented.kind === "valid" ? typeName(implemented) : null,
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
    rows,
    issues,
  };
};
