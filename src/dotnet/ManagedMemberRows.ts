import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import type { ManagedPeLayout } from "./ManagedPeReader.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  createDeclaringTypeLookup,
  signature,
  type FieldCore,
  type ManagedCallEdge,
  type ManagedField,
  type ManagedFieldAccess,
  type ManagedMemberRef,
  type ManagedMethod,
  type MemberRefCore,
  type MethodCore,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataToken,
  metadataRowCursor,
  metadataCodedToken,
  metadataCodedTokenInvalidReason,
  readMetadataBlob,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import { readManagedValue } from "./ManagedReaderFailure.js";
import { methodBody } from "./ManagedMethodBodyReader.js";

export const parseFields = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
): {
  readonly fields: readonly ManagedField[];
  readonly core: ReadonlyMap<string, FieldCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const fields: ManagedField[] = [];
  const core = new Map<string, FieldCore>();
  const issues: ManagedParseIssue[] = [];
  const table = layout.table(4);
  const declaringType = createDeclaringTypeLookup(ranges, "field");
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 4, row);
      const flags = cursor.readUInt16();
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const sig = readMetadataBlob(
        bytes,
        layout,
        cursor.readIndex(layout.blobIndexSize),
        layout.blob.size,
      );
      const declared = declaringType(row);
      const token = metadataToken(4, row);
      fields.push({
        token,
        row_offset: cursor.start,
        declaring_type_token: declared?.token ?? null,
        declaring_type: declared?.fullName ?? null,
        name,
        flags,
        signature: budgetedSignature(sig, layout),
      });
      core.set(token, { token, name });
    }, issues);
  }
  return { fields, core, issues };
};

export const parseMemberRefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): {
  readonly refs: readonly ManagedMemberRef[];
  readonly core: ReadonlyMap<string, MemberRefCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const refs: ManagedMemberRef[] = [];
  const core = new Map<string, MemberRefCore>();
  const issues: ManagedParseIssue[] = [];
  const table = layout.table(10);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 10, row);
      const parentRaw = cursor.readIndex(
        layout.codedIndexSize("MemberRefParent"),
      );
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const sig = readMetadataBlob(
        bytes,
        layout,
        cursor.readIndex(layout.blobIndexSize),
        layout.blob.size,
      );
      const token = metadataToken(10, row);
      const parentReason = metadataCodedTokenInvalidReason(
        parentRaw,
        3,
        [2, 1, 26, 6, 27],
        layout.rowCounts,
      );
      if (parentReason !== null || parentRaw === 0)
        issues.push({
          code: "invalid-row",
          scope: `metadata.MemberRef:${token}`,
          offset: cursor.start,
          detail:
            parentReason === null
              ? "MemberRef parent coded index 0x0 is null, but the Class column must reference a row"
              : `MemberRef parent coded index 0x${parentRaw.toString(16)} is invalid: ${parentReason}`,
        });
      refs.push({
        token,
        row_offset: cursor.start,
        parent_token: metadataCodedToken(
          parentRaw,
          3,
          [2, 1, 26, 6, 27],
          layout.rowCounts,
        ),
        name,
        signature: budgetedSignature(sig, layout),
      });
      core.set(token, { token, name });
    }, issues);
  }
  return { refs, core, issues };
};

interface ParseMethodsInput {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly pe: ManagedPeLayout;
  readonly ranges: readonly TypeRange[];
}

export const parseMethods = ({
  bytes,
  layout,
  pe,
  ranges,
}: ParseMethodsInput): {
  readonly methods: readonly ManagedMethod[];
  readonly core: ReadonlyMap<string, MethodCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const methods: ManagedMethod[] = [];
  const core = new Map<string, MethodCore>();
  const issues: ManagedParseIssue[] = [];
  const table = layout.table(6);
  const declaringType = createDeclaringTypeLookup(ranges, "method");
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 6, row);
      const rva = cursor.readUInt32();
      const implFlags = cursor.readUInt16();
      const flags = cursor.readUInt16();
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
        layout.strings.size,
      );
      const sig = readMetadataBlob(
        bytes,
        layout,
        cursor.readIndex(layout.blobIndexSize),
        layout.blob.size,
      );
      cursor.readIndex(layout.tableIndexSize(8));
      const declared = declaringType(row);
      const token = metadataToken(6, row);
      methods.push({
        token,
        row_offset: cursor.start,
        declaring_type_token: declared?.token ?? null,
        declaring_type: declared?.fullName ?? null,
        name,
        rva,
        impl_flags: implFlags,
        flags,
        signature: budgetedSignature(sig, layout),
        body: methodBody(
          bytes,
          pe,
          rva,
          { implFlags, flags },
          managedDecodeBudget(layout),
        ),
      });
      core.set(token, {
        token,
        name,
        declaringType: declared?.fullName ?? null,
      });
    }, issues);
  }
  return { methods, core, issues };
};

const targetKind = (token: string): ManagedCallEdge["target_kind"] =>
  token.startsWith("0x06")
    ? "method-def"
    : token.startsWith("0x0a")
      ? "member-ref"
      : token.startsWith("0x2b")
        ? "method-spec"
        : "unknown";

export const edges = (
  methods: readonly ManagedMethod[],
  methodCore: ReadonlyMap<string, MethodCore>,
  fieldCore: ReadonlyMap<string, FieldCore>,
  refCore: ReadonlyMap<string, MemberRefCore>,
): {
  readonly callEdges: readonly ManagedCallEdge[];
  readonly fieldAccesses: readonly ManagedFieldAccess[];
} => {
  const callEdges: ManagedCallEdge[] = [];
  const fieldAccesses: ManagedFieldAccess[] = [];
  for (const method of methods) {
    for (const anchor of method.body.anchors) {
      if (anchor.opcode === "ldtoken") continue;
      if (anchor.operand_kind === "method" && anchor.operand !== null) {
        const named =
          methodCore.get(anchor.operand)?.name ??
          refCore.get(anchor.operand)?.name ??
          null;
        callEdges.push({
          caller_token: method.token,
          caller:
            method.declaring_type === null
              ? method.name
              : `${method.declaring_type}.${method.name}`,
          opcode: anchor.opcode,
          target_token: anchor.operand,
          target_kind: targetKind(anchor.operand),
          target_name: named,
        });
      }
      if (anchor.operand_kind === "field" && anchor.operand !== null) {
        fieldAccesses.push({
          method_token: method.token,
          method:
            method.declaring_type === null
              ? method.name
              : `${method.declaring_type}.${method.name}`,
          opcode: anchor.opcode,
          field_token: anchor.operand,
          field_name: fieldCore.get(anchor.operand)?.name ?? null,
        });
      }
    }
  }
  return { callEdges, fieldAccesses };
};

const budgetedSignature = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): ReturnType<typeof signature> => {
  managedDecodeBudget(layout).reserve(bytes.length * 256, layout.blob.offset);
  return signature(bytes, managedDecodeBudget(layout).digest(bytes, "sha256"));
};
