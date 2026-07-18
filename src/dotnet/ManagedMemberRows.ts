import type { ManagedPeLayout } from "./ManagedPeReader.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  codedToken,
  declaringType,
  rowCursor,
  signature,
  type FieldCore,
  type ManagedCallEdge,
  type ManagedField,
  type ManagedFieldAccess,
  type ManagedMemberInspectionLimits,
  type ManagedMemberRef,
  type ManagedMethod,
  type MemberRefCore,
  type MethodCore,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataToken,
  readMetadataBlob,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import { methodBody } from "./ManagedMethodBodyReader.js";

export const parseFields = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  maxBytes: number,
): {
  readonly fields: readonly ManagedField[];
  readonly core: ReadonlyMap<string, FieldCore>;
} => {
  const fields: ManagedField[] = [];
  const core = new Map<string, FieldCore>();
  const table = layout.table(4);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 4, row);
    const flags = cursor.readUInt16();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const sig = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      maxBytes,
    );
    const declared = declaringType(ranges, "field", row);
    const token = metadataToken(4, row);
    fields.push({
      token,
      row_offset: cursor.start,
      declaring_type_token: declared?.token ?? null,
      declaring_type: declared?.fullName ?? null,
      name,
      flags,
      signature: signature(sig),
    });
    core.set(token, { token, name });
  }
  return { fields, core };
};

export const parseMemberRefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  maxBytes: number,
): {
  readonly refs: readonly ManagedMemberRef[];
  readonly core: ReadonlyMap<string, MemberRefCore>;
} => {
  const refs: ManagedMemberRef[] = [];
  const core = new Map<string, MemberRefCore>();
  const table = layout.table(10);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 10, row);
    const parentRaw = cursor.readIndex(
      layout.codedIndexSize("MemberRefParent"),
    );
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const sig = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      maxBytes,
    );
    const token = metadataToken(10, row);
    refs.push({
      token,
      row_offset: cursor.start,
      parent_token: codedToken(parentRaw, 3, [2, 1, 26, 6, 27]),
      name,
      signature: signature(sig),
    });
    core.set(token, { token, name });
  }
  return { refs, core };
};

interface ParseMethodsInput {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly pe: ManagedPeLayout;
  readonly ranges: readonly TypeRange[];
  readonly maxBytes: number;
  readonly limits: ManagedMemberInspectionLimits;
}

export const parseMethods = ({
  bytes,
  layout,
  pe,
  ranges,
  maxBytes,
  limits,
}: ParseMethodsInput): {
  readonly methods: readonly ManagedMethod[];
  readonly core: ReadonlyMap<string, MethodCore>;
} => {
  const methods: ManagedMethod[] = [];
  const core = new Map<string, MethodCore>();
  const table = layout.table(6);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    const cursor = rowCursor(bytes, layout, 6, row);
    const rva = cursor.readUInt32();
    const implFlags = cursor.readUInt16();
    const flags = cursor.readUInt16();
    const name = readMetadataString(
      bytes,
      layout,
      cursor.readIndex(layout.stringIndexSize),
      maxBytes,
    );
    const sig = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      maxBytes,
    );
    cursor.readIndex(layout.tableIndexSize(8));
    const declared = declaringType(ranges, "method", row);
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
      signature: signature(sig),
      body: methodBody(bytes, pe, rva, limits),
    });
    core.set(token, { token, name, declaringType: declared?.fullName ?? null });
  }
  return { methods, core };
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
