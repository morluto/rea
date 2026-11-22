import {
  readFieldDefinitionName,
  readFieldDefinitionRow,
} from "./ManagedFieldDefinitionRows.js";
import { createManagedFieldConstantReader } from "./ManagedFieldConstants.js";
import { readMemberReferenceRowFacts } from "../domain/managed/managedMemberReferenceRows.js";
import {
  readMethodDefinitionName,
  readMethodDefinitionRow,
} from "./ManagedMethodDefinitionRows.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import { isManagedMemberReferenceInstruction } from "../domain/managed/managedMemberInstructionFacts.js";
import {
  admitManagedProjection,
  managedDecodeBudget,
  type ManagedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import type { ManagedPeLayout } from "../domain/managed/managedPeReader.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  MANAGED_CODED_INDEXES,
  type ManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import {
  metadataSignature,
  memberTargetIdentity,
  signatureGenericArity,
  type ManagedCallEdge,
  type ManagedExportedType,
  type ManagedField,
  type ManagedFieldAccess,
  type ManagedMemberRef,
  type ManagedMethod,
  type DecodedMethod,
  type MemberCore,
  type SignatureTypeName,
  type SignatureDisplayTypeName,
  type DeclarationTypeName,
  type TypeRange,
} from "../domain/managed/managedMemberInspectorCore.js";
import {
  metadataToken,
  type MetadataTokenFact,
  metadataRowCursor,
  decodeMetadataCodedIndex,
  readMetadataBlob,
  metadataBlobOffset,
  readMetadataString,
} from "../domain/managed/managedMetadataHeaps.js";
import {
  appendManagedParseIssues,
  readManagedValue,
} from "../domain/managed/managedReaderFailure.js";
import { methodBody } from "./ManagedMethodBodyReader.js";
import { memberDeclaringTypeRowLookup } from "../domain/managed/managedMemberOwnership.js";
import type {
  MemberDefinitionTable,
  TypeMemberListFacts,
} from "../domain/managed/managedTypeMemberLists.js";
import {
  readDefinitionField,
  type UnresolvedDefinition,
} from "../domain/managed/managedUnresolvedDefinitions.js";

/**
 * Declaring-type tokens whose members are decoded in full; null selects every
 * type. Unselected members keep only their name so edges stay labelled.
 */
export type SelectedTypeTokens = ReadonlySet<string> | null;

const isSelected = (
  selected: SelectedTypeTokens,
  declared: { readonly token: string } | undefined,
): boolean =>
  selected === null || (declared !== undefined && selected.has(declared.token));

/**
 * Monotonic TypeDef list pointers without FieldPtr/MethodPtr indirection let
 * selected scopes iterate `[start, end)` directly instead of scanning or
 * allocating a full-table owner index. Any out-of-range or decreasing pointer
 * falls back cleanly to `memberDeclaringTypeRowLookup`.
 */
const canIterateMemberIntervals = (
  layout: ManagedMetadataLayout,
  table: MemberDefinitionTable,
  memberLists: TypeMemberListFacts,
  ranges: readonly TypeRange[],
): boolean => {
  const pointers = layout.table(table - 1);
  if (pointers !== undefined && pointers.rowCount > 0) return false;
  const typeCount = layout.table(2)?.rowCount ?? 0;
  if (memberLists.entries.length !== typeCount || ranges.length !== typeCount)
    return false;
  for (const entry of memberLists.entries) {
    const range = table === 4 ? entry.field : entry.method;
    if (range.start.value === null || range.end === null) return false;
  }
  return true;
};

const inPageRange = (
  start: number,
  end: number,
  methodOffset: number,
  methodLimit: number,
): { readonly from: number; readonly to: number } => {
  const pageStart = methodOffset >= end ? end : methodOffset + 1;
  const pageEnd =
    methodLimit >= end - pageStart ? end : pageStart + methodLimit;
  const from = Math.max(start, pageStart);
  return { from, to: Math.max(from, pageEnd) };
};

const memberInterval = (
  range: TypeRange | undefined,
  table: MemberDefinitionTable,
): { readonly start: number | null; readonly end: number | null } =>
  range === undefined
    ? { start: null, end: null }
    : table === 4
      ? { start: range.fieldStart, end: range.fieldEnd }
      : { start: range.methodStart, end: range.methodEnd };

const declaringTypeRowFromIntervals = (
  ranges: readonly TypeRange[],
  table: MemberDefinitionTable,
  row: number,
): number => {
  if (ranges.length === 0 || row < 1) return 0;
  const firstStart = memberInterval(ranges[0], table).start;
  if (firstStart === null || row < firstStart) return 0;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const { start } = memberInterval(ranges[mid], table);
    if (start !== null && start <= row) lo = mid;
    else hi = mid - 1;
  }
  const { start, end } = memberInterval(ranges[lo], table);
  return start !== null && end !== null && row >= start && row < end
    ? lo + 1
    : 0;
};

interface DecodeFieldContext {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly signatureTypeName: SignatureTypeName;
  readonly displayTypeName: SignatureDisplayTypeName;
  readonly declarationTypeName: DeclarationTypeName;
  readonly selected: SelectedTypeTokens;
  readonly constant: (
    row: number,
    flags: number,
  ) => ReturnType<ReturnType<typeof createManagedFieldConstantReader>>;
  readonly fields: ManagedField[];
  readonly core: Map<string, MemberCore>;
  readonly issues: ManagedParseIssue[];
}

const decodeFieldRow = (
  context: DecodeFieldContext,
  row: number,
  owner: number | undefined,
  declared: TypeRange | undefined,
): void => {
  const {
    bytes,
    layout,
    signatureTypeName,
    displayTypeName,
    declarationTypeName,
    selected,
    constant,
    fields,
    core,
    issues,
  } = context;
  readManagedValue(() => {
    const definition = readFieldDefinitionRow(bytes, layout, row);
    const { token, rowOffset, flags, signatureIndex } = definition;
    const name = readFieldDefinitionName(bytes, layout, definition);
    const owned = owner ?? 0;
    core.set(token, {
      token,
      name,
      declaringType: declared?.fullName ?? null,
      kind: "field",
    });
    if (!isSelected(selected, declared)) return;
    const sig = readMetadataBlob(bytes, layout, signatureIndex);
    const decoded = budgetedSignature(
      sig,
      layout,
      signatureTypeName,
      displayTypeName,
      issues,
      { scope: `Field:${token}.signature`, kind: "field", artifact: bytes },
    );
    core.set(token, {
      token,
      name,
      declaringType: declared?.fullName ?? null,
      kind: "field",
      identitySha256: memberTargetIdentity(
        name,
        declared === undefined ? null : { table: 2, row: owned },
        decoded,
        declarationTypeName,
      ),
    });
    fields.push({
      token,
      row_offset: rowOffset,
      declaring_type_token: declared?.token ?? null,
      declaring_type: declared?.fullName ?? null,
      name,
      flags,
      signature: decoded,
      constant: constant(row, flags),
    });
  }, issues);
};

export const parseFields = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  memberLists: TypeMemberListFacts,
  {
    signatureTypeName,
    displayTypeName,
    declarationTypeName,
    selected = null,
  }: {
    readonly signatureTypeName: SignatureTypeName;
    readonly displayTypeName: SignatureDisplayTypeName;
    readonly declarationTypeName: DeclarationTypeName;
    readonly selected?: SelectedTypeTokens;
  },
): {
  readonly fields: readonly ManagedField[];
  readonly core: ReadonlyMap<string, MemberCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const fields: ManagedField[] = [];
  const core = new Map<string, MemberCore>();
  const issues: ManagedParseIssue[] = [];
  const constant = createManagedFieldConstantReader(bytes, layout, issues, {
    selected: selected !== null,
  });
  const rowCount = layout.table(4)?.rowCount ?? 0;
  const context: DecodeFieldContext = {
    bytes,
    layout,
    signatureTypeName,
    displayTypeName,
    declarationTypeName,
    selected,
    constant,
    fields,
    core,
    issues,
  };
  if (
    selected !== null &&
    canIterateMemberIntervals(layout, 4, memberLists, ranges)
  ) {
    for (let owner = 1; owner <= ranges.length; owner += 1) {
      const declared = ranges[owner - 1];
      if (declared === undefined || !isSelected(selected, declared)) continue;
      const start = declared.fieldStart;
      const end = declared.fieldEnd;
      if (start === null || end === null) continue;
      const lastExclusive = Math.min(end, rowCount + 1);
      for (let row = start; row < lastExclusive; row += 1)
        decodeFieldRow(context, row, owner, declared);
    }
    return { fields, core, issues };
  }
  const ownerRow = readManagedValue(
    () => memberDeclaringTypeRowLookup(bytes, layout, 4, memberLists),
    issues,
  );
  for (let row = 1; row <= rowCount; row += 1) {
    // The owner comes from the shared range lookup, not the row itself: a
    // row belonging to no selected type is skipped without a cursor or name
    // charge. A selected method that references such a row keeps its name
    // through readReferencedMemberCores instead.
    const owner =
      ownerRow === undefined
        ? undefined
        : readManagedValue(() => ownerRow(row), issues);
    const declared = owner === undefined ? undefined : ranges[owner - 1];
    if (
      owner !== undefined &&
      selected !== null &&
      !isSelected(selected, declared)
    )
      continue;
    decodeFieldRow(context, row, owner, declared);
  }
  return { fields, core, issues };
};

const TYPE_FORWARDER_FLAG = 0x0020_0000;

/** Read ExportedType rows, including type forwarders, as declared. */
export const parseExportedTypes = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
): {
  readonly exportedTypes: readonly ManagedExportedType[];
  readonly issues: readonly ManagedParseIssue[];
} => {
  const exportedTypes: ManagedExportedType[] = [];
  const issues: ManagedParseIssue[] = [];
  const table = layout.table(39);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const cursor = metadataRowCursor(bytes, layout, 39, row);
      const flags = cursor.u32();
      const typeDefId = cursor.u32();
      const name = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
      );
      const namespace = readMetadataString(
        bytes,
        layout,
        cursor.readIndex(layout.stringIndexSize),
      );
      const implementationOffset = cursor.offset;
      const implementationRaw = cursor.readIndex(
        layout.codedIndexSize("Implementation"),
      );
      const token = metadataToken(39, row);
      const implementation = decodeMetadataCodedIndex(
        implementationRaw,
        MANAGED_CODED_INDEXES.Implementation.bits,
        MANAGED_CODED_INDEXES.Implementation.tables,
        layout.rowCounts,
      );
      if (implementation.kind !== "valid")
        issues.push({
          code: "invalid-row",
          scope: `metadata.ExportedType:${token}`,
          offset: implementationOffset,
          detail:
            implementation.kind === "null"
              ? "ExportedType implementation coded index 0x0 is null, but the Implementation column must reference a row"
              : `ExportedType implementation coded index 0x${implementationRaw.toString(16)} is invalid: ${implementation.reason}`,
        });
      exportedTypes.push({
        token,
        row_offset: cursor.start,
        namespace,
        name,
        flags,
        forwarder: (flags & TYPE_FORWARDER_FLAG) !== 0,
        type_def_id: typeDefId,
        implementation_token:
          implementation.kind === "valid" ? implementation.token : null,
      });
    }, issues);
  }
  return { exportedTypes, issues };
};

export const parseMemberRefs = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  {
    typeName,
    isResolvedTypeSpec,
    signatureTypeName,
    displayTypeName,
    declarationTypeName,
  }: {
    readonly typeName: (
      reference: Pick<MetadataTokenFact, "table" | "row" | "token"> | null,
    ) => string | null;
    readonly isResolvedTypeSpec: (
      reference: Pick<MetadataTokenFact, "table" | "row" | "token"> | null,
    ) => boolean;
    readonly signatureTypeName: SignatureTypeName;
    readonly displayTypeName: SignatureDisplayTypeName;
    readonly declarationTypeName: DeclarationTypeName;
  },
): {
  readonly refs: readonly ManagedMemberRef[];
  readonly core: ReadonlyMap<string, MemberCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const refs: ManagedMemberRef[] = [];
  const core = new Map<string, MemberCore>();
  const issues: ManagedParseIssue[] = [];
  const table = layout.table(10);
  for (let row = 1; row <= (table?.rowCount ?? 0); row += 1) {
    readManagedValue(() => {
      const { token, rowOffset, parentRaw, parent, nameIndex, signatureIndex } =
        readMemberReferenceRowFacts(bytes, layout, row);
      const name = readMetadataString(bytes, layout, nameIndex);
      const sig = readMetadataBlob(bytes, layout, signatureIndex);
      if (parent.kind !== "valid")
        issues.push({
          code: "invalid-row",
          scope: `metadata.MemberRef:${token}`,
          offset: rowOffset,
          detail:
            parent.kind === "null"
              ? "MemberRef parent coded index 0x0 is null, but the Class column must reference a row"
              : `MemberRef parent coded index 0x${parentRaw.toString(16)} is invalid: ${parent.reason}`,
        });
      const parentToken = parent.kind === "valid" ? parent.token : null;
      const parentName = typeName(parent.kind === "valid" ? parent : null);
      const decoded = budgetedSignature(
        sig,
        layout,
        signatureTypeName,
        displayTypeName,
        issues,
        { scope: `MemberRef:${token}.signature`, artifact: bytes },
      );
      refs.push({
        token,
        row_offset: rowOffset,
        parent_token: parentToken,
        parent_name: parentName,
        name,
        signature: decoded,
      });
      core.set(token, {
        token,
        name,
        declaringType: parentName,
        kind: decoded.kind,
        genericArity: signatureGenericArity(decoded),
        rowResolved:
          parent.kind === "valid" &&
          parent.table === 27 &&
          isResolvedTypeSpec(parent) &&
          decoded.parse_status === "decoded" &&
          decoded.resolved_sha256 !== null,
        identitySha256: memberTargetIdentity(
          name,
          parent.kind === "valid" ? parent : null,
          decoded,
          declarationTypeName,
        ),
      });
    }, issues);
  }
  return { refs, core, issues };
};

interface ParseMethodsInput {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly pe: ManagedPeLayout;
  readonly ranges: readonly TypeRange[];
  readonly signatureTypeName: SignatureTypeName;
  readonly displayTypeName: SignatureDisplayTypeName;
  readonly declarationTypeName: DeclarationTypeName;
  readonly memberRefKinds: ReadonlyMap<string, "field" | "method">;
  readonly memberLists: TypeMemberListFacts;
  readonly selected?: SelectedTypeTokens;
  readonly methodOffset?: number;
  readonly methodLimit?: number;
}

interface DecodeMethodContext {
  readonly bytes: Buffer;
  readonly layout: ManagedMetadataLayout;
  readonly pe: ManagedPeLayout;
  readonly signatureTypeName: SignatureTypeName;
  readonly displayTypeName: SignatureDisplayTypeName;
  readonly declarationTypeName: DeclarationTypeName;
  readonly memberRefKinds: ReadonlyMap<string, "field" | "method">;
  readonly selected: SelectedTypeTokens;
  readonly methodOffset: number;
  readonly methodLimit: number;
  readonly methods: DecodedMethod[];
  readonly unresolvedDefinitions: UnresolvedDefinition[];
  readonly core: Map<string, MemberCore>;
  readonly issues: ManagedParseIssue[];
  unscannedMethods: number;
}

const decodeMethodRow = (
  context: DecodeMethodContext,
  row: number,
  owner: number | undefined,
  declared: TypeRange | undefined,
): void => {
  const {
    bytes,
    layout,
    pe,
    signatureTypeName,
    displayTypeName,
    declarationTypeName,
    memberRefKinds,
    selected,
    methodOffset,
    methodLimit,
    methods,
    unresolvedDefinitions,
    core,
    issues,
  } = context;
  const inPage = row > methodOffset && row - methodOffset <= methodLimit;
  const selectedForEvidence = inPage && isSelected(selected, declared);
  const mayBeSelected =
    inPage &&
    (selected === null ||
      owner === undefined ||
      owner === 0 ||
      isSelected(selected, declared) ||
      // A type whose name is unreadable may be one the caller requested.
      declared?.fullName === null);
  const produced = methods.length;
  readManagedValue(() => {
    const definition = readMethodDefinitionRow(bytes, layout, row);
    const {
      token,
      rowOffset,
      rva,
      implFlags,
      flags,
      signatureIndex,
      implementation,
    } = definition;
    const name = readDefinitionField(
      () => readMethodDefinitionName(bytes, layout, definition),
      issues,
      "Name",
      definition.nameOffset,
      definition.nameIndex,
    );
    if (typeof name !== "string") {
      if (selectedForEvidence)
        unresolvedDefinitions.push(
          admitManagedProjection(
            {
              kind: "MethodDef",
              token,
              row_offset: rowOffset,
              declaring_type_token: declared?.token ?? null,
              rva,
              failed_fields: [name],
            },
            managedDecodeBudget(layout),
          ),
        );
      return;
    }
    const member = {
      token,
      name,
      declaringType: declared?.fullName ?? null,
      kind: "method",
    } as const;
    core.set(token, member);
    if (!selectedForEvidence) return;
    const sig = readMetadataBlob(bytes, layout, signatureIndex);
    const decoded = budgetedSignature(
      sig,
      layout,
      signatureTypeName,
      displayTypeName,
      issues,
      {
        scope: `MethodDef:${token}.signature`,
        kind: "method",
        artifact: bytes,
      },
    );
    core.set(token, {
      ...member,
      genericArity: signatureGenericArity(decoded),
      identitySha256: memberTargetIdentity(
        name,
        declared === undefined || owner === undefined
          ? null
          : { table: 2, row: owner },
        decoded,
        declarationTypeName,
      ),
    });
    const read = methodBody(bytes, pe, rva, {
      implementation,
      budget: managedDecodeBudget(layout),
      metadataLayout: layout,
      methodToken: token,
      memberRefKinds,
    });
    appendManagedParseIssues(issues, read.issues);
    if (!read.scanned) context.unscannedMethods += 1;
    managedDecodeBudget(layout).reserve(128, rowOffset);
    methods.push({
      tokenInstructions: read.tokenInstructions,
      catchTokens: read.catchTokens,
      method: {
        token,
        row_offset: rowOffset,
        declaring_type_token: declared?.token ?? null,
        declaring_type: declared?.fullName ?? null,
        name,
        rva,
        impl_flags: implFlags,
        flags,
        signature: decoded,
        body: read.body,
      },
    });
  }, issues);
  if (mayBeSelected && methods.length === produced)
    context.unscannedMethods += 1;
};

const parseSelectedMethodIntervals = (
  context: DecodeMethodContext,
  ranges: readonly TypeRange[],
  selected: ReadonlySet<string>,
  rowCount: number,
): void => {
  const firstStart = ranges[0]?.methodStart ?? rowCount + 1;
  const unownedEnd = Math.min(firstStart, rowCount + 1);
  if (unownedEnd > 1) {
    const unownedPage = inPageRange(
      1,
      unownedEnd,
      context.methodOffset,
      context.methodLimit,
    );
    context.unscannedMethods += unownedPage.to - unownedPage.from;
  }
  for (let owner = 1; owner <= ranges.length; owner += 1) {
    const declared = ranges[owner - 1];
    if (declared === undefined) continue;
    const start = declared.methodStart;
    const end = declared.methodEnd;
    if (start === null || end === null) continue;
    const lastExclusive = Math.min(end, rowCount + 1);
    if (!isSelected(selected, declared)) {
      if (declared.fullName === null) {
        const page = inPageRange(
          start,
          lastExclusive,
          context.methodOffset,
          context.methodLimit,
        );
        context.unscannedMethods += page.to - page.from;
      }
      continue;
    }
    for (let row = start; row < lastExclusive; row += 1)
      decodeMethodRow(context, row, owner, declared);
  }
};

export const parseMethods = ({
  bytes,
  layout,
  pe,
  ranges,
  signatureTypeName,
  displayTypeName,
  declarationTypeName,
  memberRefKinds,
  memberLists,
  selected = null,
  methodOffset = 0,
  methodLimit = Number.MAX_SAFE_INTEGER,
}: ParseMethodsInput): {
  readonly methods: readonly DecodedMethod[];
  readonly core: ReadonlyMap<string, MemberCore>;
  readonly issues: readonly ManagedParseIssue[];
  /**
   * Methods that may belong to a selected type but whose CIL was not fully
   * scanned: rows that produced no method, or bodies whose decoding stopped.
   */
  readonly unscannedMethods: number;
  readonly unresolvedDefinitions: UnresolvedDefinition[];
} => {
  const methods: DecodedMethod[] = [];
  const unresolvedDefinitions: UnresolvedDefinition[] = [];
  const core = new Map<string, MemberCore>();
  const issues: ManagedParseIssue[] = [];
  const context: DecodeMethodContext = {
    bytes,
    layout,
    pe,
    signatureTypeName,
    displayTypeName,
    declarationTypeName,
    memberRefKinds,
    selected,
    methodOffset,
    methodLimit,
    methods,
    unresolvedDefinitions,
    core,
    issues,
    unscannedMethods: 0,
  };
  const rowCount = layout.table(6)?.rowCount ?? 0;
  if (
    selected !== null &&
    canIterateMemberIntervals(layout, 6, memberLists, ranges)
  ) {
    parseSelectedMethodIntervals(context, ranges, selected, rowCount);
    return {
      methods,
      core,
      issues,
      unscannedMethods: context.unscannedMethods,
      unresolvedDefinitions,
    };
  }
  const ownerRow = readManagedValue(
    () => memberDeclaringTypeRowLookup(bytes, layout, 6, memberLists),
    issues,
  );
  for (let row = 1; row <= rowCount; row += 1) {
    // The owner is read first: a row that produced no method hides a selected
    // body only when its owner is selected, unknown, or unreadably named.
    const owner =
      ownerRow === undefined
        ? undefined
        : readManagedValue(() => ownerRow(row), issues);
    const declared = owner === undefined ? undefined : ranges[owner - 1];
    // As in parseFields: a row belonging to no selected type is skipped
    // without reading it. The unscanned count keeps its existing meaning:
    // a skipped row hides a selected body only when its owner is unknown
    // or unreadably named.
    if (
      owner !== undefined &&
      selected !== null &&
      !isSelected(selected, declared)
    ) {
      const inPage = row > methodOffset && row - methodOffset <= methodLimit;
      if (inPage && (owner === 0 || declared?.fullName === null))
        context.unscannedMethods += 1;
      continue;
    }
    decodeMethodRow(context, row, owner, declared);
  }
  return {
    methods,
    core,
    issues,
    unscannedMethods: context.unscannedMethods,
    unresolvedDefinitions,
  };
};

/**
 * Core entries for Field and MethodDef rows a selected method's body
 * references. Edge targets outside the selection keep their names, but
 * reading every unselected row to name them spends the representation
 * budget on the whole assembly; only referenced rows are read here.
 * MemberRef tokens need no fill: member references decode in full.
 */
export const readReferencedMemberCores = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  memberLists: TypeMemberListFacts,
  references: Iterable<Pick<MetadataTokenFact, "table" | "row" | "token">>,
): {
  readonly core: ReadonlyMap<string, MemberCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const core = new Map<string, MemberCore>();
  const issues: ManagedParseIssue[] = [];
  const ownerRows = new Map<number, ((row: number) => number) | undefined>();
  const ownerOf = (table: 4 | 6, row: number): number => {
    if (!ownerRows.has(table))
      ownerRows.set(
        table,
        canIterateMemberIntervals(layout, table, memberLists, ranges)
          ? (targetRow) =>
              declaringTypeRowFromIntervals(ranges, table, targetRow)
          : readManagedValue(
              () =>
                memberDeclaringTypeRowLookup(bytes, layout, table, memberLists),
              issues,
            ),
      );
    return ownerRows.get(table)?.(row) ?? 0;
  };
  for (const { table, row, token } of references) {
    if (table !== 4 && table !== 6) continue;
    if (core.has(token)) continue;
    // A body can name a row its table does not contain: the edge stays
    // unnamed, as before, instead of reporting a row that was never read.
    // A row that exists but cannot be read still reports its issue below.
    if (row < 1 || row > (layout.table(table)?.rowCount ?? 0)) continue;
    readManagedValue(() => {
      const declared = ranges[ownerOf(table, row) - 1];
      const name =
        table === 4
          ? readFieldDefinitionName(
              bytes,
              layout,
              readFieldDefinitionRow(bytes, layout, row),
            )
          : readMethodDefinitionName(
              bytes,
              layout,
              readMethodDefinitionRow(bytes, layout, row),
            );
      core.set(token, {
        token,
        name,
        declaringType: declared?.fullName ?? null,
        kind: table === 4 ? "field" : "method",
      });
    }, issues);
  }
  return { core, issues };
};

/**
 * Member kinds each operand kind may name. A MemberRef whose signature does
 * not decode keeps its name on calls, as before, but is never named a field.
 */
const NAMEABLE_KINDS = new Map<string, ReadonlySet<MemberCore["kind"]>>([
  ["method", new Set(["method", "unknown"])],
  ["field", new Set(["field"])],
]);

const targetKind = (table: number): ManagedCallEdge["target_kind"] =>
  table === 6
    ? "method-def"
    : table === 0x0a
      ? "member-ref"
      : table === 0x2b
        ? "method-spec"
        : "unknown";

/** The member an operand names, if the operand kind can name that member's kind. */
const namedTarget = (
  members: ReadonlyMap<string, MemberCore>,
  operandKind: string,
  operand: string,
): MemberCore | undefined => {
  const member = members.get(operand);
  return member !== undefined &&
    NAMEABLE_KINDS.get(operandKind)?.has(member.kind) === true
    ? member
    : undefined;
};

export const edges = (
  methods: readonly DecodedMethod[],
  members: ReadonlyMap<string, MemberCore>,
  budget: ManagedDecodeBudget,
): {
  readonly callEdges: readonly ManagedCallEdge[];
  readonly fieldAccesses: readonly ManagedFieldAccess[];
} => {
  const callEdges: ManagedCallEdge[] = [];
  const fieldAccesses: ManagedFieldAccess[] = [];
  for (const { method, tokenInstructions } of methods) {
    const derives = tokenInstructions.some((instruction) =>
      isManagedMemberReferenceInstruction({
        opcode: instruction.opcode,
        operand_kind: instruction.operandKind,
        operand: instruction.operand,
      }),
    );
    if (derives) budget.admitTransient(callerNameBytes(method), null);
    // Built once per method, only after its exact size was admitted.
    const caller = derives ? callerName(method) : method.name;
    for (const instruction of tokenInstructions) {
      const anchor = {
        opcode: instruction.opcode,
        operand_kind: instruction.operandKind,
        operand: instruction.operand,
      };
      if (!isManagedMemberReferenceInstruction(anchor)) continue;
      const { operand } = anchor;
      const target = namedTarget(members, anchor.operand_kind, operand);
      const targetRowResolved =
        target !== undefined &&
        (target.identitySha256 != null || target.rowResolved === true);
      if (anchor.operand_kind === "method") {
        // Each derived record is admitted before the graph grows further.
        callEdges.push(
          admitManagedProjection(
            {
              caller_token: method.token,
              il_offset: instruction.offset,
              target_identity_sha256: target?.identitySha256 ?? null,
              target_row_resolved: targetRowResolved,
              caller,
              opcode: anchor.opcode,
              target_token: operand,
              target_kind: targetKind(instruction.reference.table),
              target_name: target?.name ?? null,
              target_declaring_type: target?.declaringType ?? null,
            },
            budget,
          ),
        );
      }
      if (anchor.operand_kind === "field") {
        fieldAccesses.push(
          admitManagedProjection(
            {
              method_token: method.token,
              il_offset: instruction.offset,
              target_identity_sha256: target?.identitySha256 ?? null,
              target_row_resolved: targetRowResolved,
              method: caller,
              opcode: anchor.opcode,
              field_token: operand,
              field_name: target?.name ?? null,
              field_declaring_type: target?.declaringType ?? null,
            },
            budget,
          ),
        );
      }
    }
    // Every record now reserves the name it carries.
    if (derives) budget.releaseTransient();
  }
  return { callEdges, fieldAccesses };
};

const callerName = (method: ManagedMethod): string =>
  method.declaring_type === null
    ? method.name
    : `${method.declaring_type}.${method.name}`;

/** JSON bytes of `callerName`, from its parts: the joining dot adds one byte. */
const callerNameBytes = (method: ManagedMethod): number =>
  method.declaring_type === null
    ? jsonStringByteLength(method.name)
    : jsonStringByteLength(method.declaring_type) +
      jsonStringByteLength(method.name) -
      1;

const budgetedSignature = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  signatureTypeName: SignatureTypeName,
  displayTypeName: SignatureDisplayTypeName,
  issues: ManagedParseIssue[],
  owner: {
    readonly scope: string;
    readonly kind?: "field" | "method";
    /** The artifact the blob was read from, for artifact issue offsets. */
    readonly artifact: Buffer;
  },
): ReturnType<typeof metadataSignature> => {
  const budget = managedDecodeBudget(layout);
  budget.admitTransient(bytes.length * 256, metadataBlobOffset(layout));
  try {
    return admitManagedProjection(
      metadataSignature(bytes, {
        rawSha256: budget.digest(bytes, "sha256"),
        typeName: signatureTypeName,
        displayTypeName: (operand, copies) => {
          const name = displayTypeName(operand, copies);
          if (name !== null)
            budget.admitTransient(
              (name.length * 6 + 2) * copies,
              metadataBlobOffset(layout),
            );
          return name;
        },
        layout,
        issues,
        scope: owner.scope,
        blobOffset: bytes.byteOffset - owner.artifact.byteOffset,
        ...(owner.kind === undefined ? {} : { expectedKind: owner.kind }),
      }),
      budget,
    );
  } finally {
    budget.releaseTransient();
  }
};
