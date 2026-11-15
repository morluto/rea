import { createHash } from "node:crypto";
import type { ManagedTypeReferenceLookup } from "./ManagedTypeReferences.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  fullName,
  specSignatureFacts,
  type DeclarationTypeName,
  type SignatureTypeName,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataRowCursor,
  type MetadataTokenFact,
  metadataToken,
  readMetadataBlob,
} from "./ManagedMetadataHeaps.js";
import { readManagedValue } from "./ManagedReaderFailure.js";

/** The facts a TypeDef, TypeRef, or TypeSpec token gives about its type. */
export interface ManagedTypeTokenFacts {
  /** Namespace-qualified name; a non-generic TypeSpec has none. */
  readonly name: string | null;
  /**
   * Nominal identity digest: a TypeDef or TypeRef's name digest, or for a
   * TypeSpec, a digest of its whole resolved signature (so `List<int>` and
   * `List<string>` differ). Null when a name or operand is unresolved.
   */
  readonly identity: Buffer | null;
}

export type ManagedTypeTokenLookup = (
  reference: Pick<MetadataTokenFact, "table" | "row" | "token"> | null,
) => ManagedTypeTokenFacts;

const UNKNOWN_TYPE: ManagedTypeTokenFacts = { name: null, identity: null };

/**
 * Name and identify the type a TypeDef, TypeRef, or TypeSpec token denotes,
 * once per token. Names use the namespace-qualified form TypeDef `full_name`
 * uses; a generic-instantiation TypeSpec is named by its generic type, and
 * other decoded TypeSpecs have no name. Malformed or unsupported rows and
 * blobs are reported to `issues` and stay unknown, except that a TypeRef with
 * an invalid ResolutionScope keeps its readable name.
 */
export const typeTokenLookup = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  issues: ManagedParseIssue[],
  references: ManagedTypeReferenceLookup,
  identities: {
    readonly signatureTypeName: SignatureTypeName;
    readonly declarationTypeName: DeclarationTypeName;
  },
): ManagedTypeTokenLookup => {
  const facts = new Map<string, ManagedTypeTokenFacts>();
  const definitionName = (table: 1 | 2, row: number): string | null => {
    if (table === 2) {
      metadataRowOffset(layout, 2, row);
      return ranges[row - 1]?.fullName ?? null;
    }
    const reference = references(row);
    return reference === null
      ? null
      : fullName(reference.namespace, reference.name);
  };
  const definition = (table: 1 | 2, row: number): ManagedTypeTokenFacts => ({
    name: definitionName(table, row),
    identity: identities.declarationTypeName(table, row),
  });
  const spec = (row: number): ManagedTypeTokenFacts => {
    const cursor = metadataRowCursor(bytes, layout, 27, row);
    const blob = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      layout.blob?.size ?? 0,
    );
    const owner = {
      form: "type",
      scope: `metadata.TypeSpec:${metadataToken(27, row)}`,
      offset: cursor.start,
    } as const;
    const { nominalGenericType, resolvedSha256 } = specSignatureFacts(
      layout,
      blob,
      owner,
      identities.signatureTypeName,
    );
    return {
      name:
        nominalGenericType === null
          ? null
          : definitionName(nominalGenericType.table, nominalGenericType.row),
      identity:
        resolvedSha256 === null
          ? null
          : createHash("sha256")
              .update("managed-type-spec-v1\0")
              .update(Buffer.from(resolvedSha256, "hex"))
              .digest(),
    };
  };
  return (reference) => {
    if (reference === null) return UNKNOWN_TYPE;
    const { token, table, row } = reference;
    const known = facts.get(token);
    if (known !== undefined) return known;
    const value =
      readManagedValue(
        () =>
          table === 27
            ? spec(row)
            : table === 1 || table === 2
              ? definition(table, row)
              : UNKNOWN_TYPE,
        issues,
      ) ?? UNKNOWN_TYPE;
    facts.set(token, value);
    return value;
  };
};
