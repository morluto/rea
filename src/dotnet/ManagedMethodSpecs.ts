import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  methodGenericArity,
  specSignature,
  type ManagedMethod,
  type MemberCore,
} from "./ManagedMemberInspectorCore.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  metadataCodedToken,
  metadataCodedTokenInvalidReason,
  metadataRowCursor,
  readMetadataBlob,
} from "./ManagedMetadataHeaps.js";
import { managedFailure, readManagedValue } from "./ManagedReaderFailure.js";

/**
 * Index fields, member references, and methods by token, then name each
 * MethodSpec an inspected body calls after the generic method it instantiates,
 * so every edge target resolves through one lookup.
 */
export const edgeTargets = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  methods: readonly ManagedMethod[],
  cores: readonly ReadonlyMap<string, MemberCore>[],
): {
  readonly members: ReadonlyMap<string, MemberCore>;
  readonly issues: readonly ManagedParseIssue[];
} => {
  const members = new Map(cores.flatMap((core) => [...core]));
  const issues: ManagedParseIssue[] = [];
  const seen = new Set<string>();
  // Generic arity by method token, so instantiations of one method decode it once.
  const arities = new Map<string, number | null>();
  for (const method of methods)
    for (const { operand } of method.body.anchors) {
      if (operand?.startsWith("0x2b") !== true || seen.has(operand)) continue;
      seen.add(operand);
      readManagedValue(
        () =>
          readMethodSpec({ bytes, layout, members, issues, arities }, operand),
        issues,
      );
    }
  return { members, issues };
};

/**
 * Map one MethodSpec to its generic method, then check its instantiation
 * decodes and matches that method's generic arity. A readable Method column
 * keeps its name when the rest is malformed; the failure makes coverage partial.
 */
const readMethodSpec = (
  {
    bytes,
    layout,
    members,
    issues,
    arities,
  }: {
    readonly bytes: Buffer;
    readonly layout: ManagedMetadataLayout;
    readonly members: Map<string, MemberCore>;
    readonly issues: ManagedParseIssue[];
    readonly arities: Map<string, number | null>;
  },
  token: string,
): void => {
  const scope = `metadata.MethodSpec:${token}`;
  const cursor = metadataRowCursor(
    bytes,
    layout,
    0x2b,
    Number.parseInt(token.slice(4), 16),
  );
  const methodRaw = cursor.readIndex(layout.codedIndexSize("MethodDefOrRef"));
  const instantiation = cursor.readIndex(layout.blobIndexSize);
  const methodReason = metadataCodedTokenInvalidReason(
    methodRaw,
    1,
    [6, 10],
    layout.rowCounts,
  );
  if (methodReason !== null || methodRaw === 0)
    issues.push({
      code: "invalid-row",
      scope,
      offset: cursor.start,
      detail:
        methodReason === null
          ? "MethodSpec method coded index 0x0 is null, but the Method column must reference a row"
          : `MethodSpec method coded index 0x${methodRaw.toString(16)} is invalid: ${methodReason}`,
    });
  const generic = metadataCodedToken(methodRaw, 1, [6, 10], layout.rowCounts);
  const target = generic === null ? undefined : members.get(generic);
  // A MethodSpec instantiates a method, so a field target never lends it a
  // name, even to a field operand.
  if (target !== undefined && target.kind !== "field")
    members.set(token, { ...target, token });
  const types = specSignature(
    layout,
    readMetadataBlob(bytes, layout, instantiation, layout.blob.size),
    { form: "instantiation", scope, offset: cursor.start },
  );
  if (generic === null) return;
  // Prefer the arity the target's owner decoded; read the raw signature only
  // for a target nothing decoded, such as a MethodDef outside the selection.
  if (target?.genericArity === undefined && !arities.has(generic))
    arities.set(
      generic,
      methodGenericArity(layout, methodSignatureBlob(bytes, layout, generic)),
    );
  const arity =
    target?.genericArity === undefined
      ? (arities.get(generic) ?? null)
      : target.genericArity;
  if (arity !== types.length)
    throw managedFailure(
      "invalid-row",
      scope,
      arity === null
        ? "MethodSpec method does not have a decodable method signature"
        : `MethodSpec supplies ${String(types.length)} type argument(s), but its method declares ${String(arity)} generic parameter(s)`,
      cursor.start,
    );
};

/** The Signature column of a MethodDef or MemberRef row. */
const methodSignatureBlob = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  token: string,
): Buffer => {
  const table = Number.parseInt(token.slice(2, 4), 16);
  const cursor = metadataRowCursor(
    bytes,
    layout,
    table,
    Number.parseInt(token.slice(4), 16),
  );
  if (table === 6) {
    cursor.readUInt32();
    cursor.readUInt16();
    cursor.readUInt16();
  } else cursor.readIndex(layout.codedIndexSize("MemberRefParent"));
  cursor.readIndex(layout.stringIndexSize);
  return readMetadataBlob(
    bytes,
    layout,
    cursor.readIndex(layout.blobIndexSize),
    layout.blob.size,
  );
};
