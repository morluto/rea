import type { ManagedTypeReferenceLookup } from "./ManagedTypeReferences.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  fullName,
  specSignatureFacts,
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

/**
 * Name the type a TypeDef, TypeRef, or generic-instantiation TypeSpec token
 * denotes, in the namespace-qualified form TypeDef `full_name` uses, once per
 * token. Other decoded TypeSpecs retain a null display name while a resolved
 * signature can still establish a local row. Malformed or
 * unsupported rows and blobs are reported to `issues` and also stay null,
 * except that a TypeRef with an invalid ResolutionScope keeps its readable name.
 */
export const typeNameLookup = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  issues: ManagedParseIssue[],
  references: ManagedTypeReferenceLookup,
  signatureTypeName: SignatureTypeName,
): {
  readonly name: (reference: TypeReference) => string | null;
  readonly isResolvedTypeSpec: (reference: TypeReference) => boolean;
} => {
  type Facts = { readonly name: string | null; readonly resolvedSpec: boolean };
  const unknown: Facts = { name: null, resolvedSpec: false };
  const names = new Map<string, Facts>();
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
  const specName = (row: number): Facts => {
    const cursor = metadataRowCursor(bytes, layout, 27, row);
    const spec = readMetadataBlob(
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
      spec,
      owner,
      signatureTypeName,
    );
    return {
      name:
        nominalGenericType === null
          ? null
          : definitionName(nominalGenericType.table, nominalGenericType.row),
      resolvedSpec: resolvedSha256 !== null,
    };
  };
  const read = (reference: TypeReference): Facts => {
    if (reference === null) return unknown;
    const { token, table, row } = reference;
    if (names.has(token)) return names.get(token) ?? unknown;
    const name =
      readManagedValue(
        () =>
          table === 27
            ? specName(row)
            : table === 1 || table === 2
              ? { name: definitionName(table, row), resolvedSpec: false }
              : unknown,
        issues,
      ) ?? unknown;
    names.set(token, name);
    return name;
  };
  return {
    name: (reference) => read(reference).name,
    isResolvedTypeSpec: (reference) => read(reference).resolvedSpec,
  };
};

type TypeReference = Pick<MetadataTokenFact, "table" | "row" | "token"> | null;
