import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  fullName,
  readCompressed,
  specSignature,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataCodedTokenInvalidReason,
  metadataRowCursor,
  metadataToken,
  readMetadataBlob,
  readMetadataString,
} from "./ManagedMetadataHeaps.js";
import { managedFailure, readManagedValue } from "./ManagedReaderFailure.js";

/**
 * Name the type a TypeDef, TypeRef, or generic-instantiation TypeSpec token
 * denotes, in the namespace-qualified form TypeDef `full_name` uses, once per
 * token. Other decoded TypeSpecs stay null: the type is unknown. Malformed or
 * unsupported rows and blobs are reported to `issues` and also stay null,
 * except that a TypeRef with an invalid ResolutionScope keeps its readable name.
 */
export const typeNameLookup = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  issues: ManagedParseIssue[],
): ((token: string | null) => string | null) => {
  const names = new Map<string, string | null>();
  const checkedScopes = new Set<number>();
  const validateScopeChain = (row: number): void => {
    const path = new Set<number>();
    let current = row;
    while (!checkedScopes.has(current)) {
      const cursor = metadataRowCursor(bytes, layout, 1, current);
      if (path.has(current)) {
        issues.push({
          code: "invalid-row",
          scope: `metadata.TypeRef:${metadataToken(1, current)}`,
          offset: cursor.start,
          detail: "TypeRef ResolutionScope chain contains a cycle",
        });
        break;
      }
      // Admit the chain's visited entry and retained validation-cache entry.
      managedDecodeBudget(layout).reserve(128, cursor.start);
      path.add(current);
      const raw = cursor.readIndex(layout.codedIndexSize("ResolutionScope"));
      const reason = metadataCodedTokenInvalidReason(
        raw,
        2,
        [0, 26, 35, 1],
        layout.rowCounts,
      );
      if (reason !== null) {
        issues.push({
          code: "invalid-row",
          scope: `metadata.TypeRef:${metadataToken(1, current)}`,
          offset: cursor.start,
          detail: `TypeRef ResolutionScope coded index 0x${raw.toString(16)} is invalid: ${reason}`,
        });
        break;
      }
      // Null scopes are legal; non-TypeRef scopes terminate local validation.
      if (raw === 0 || (raw & 3) !== 3) break;
      current = Math.floor(raw / 4);
    }
    for (const visited of path) checkedScopes.add(visited);
  };
  const definitionName = (table: 1 | 2, row: number): string | null => {
    if (table === 2) {
      metadataRowOffset(layout, 2, row);
      return ranges[row - 1]?.fullName ?? null;
    }
    const cursor = metadataRowCursor(bytes, layout, 1, row);
    cursor.readIndex(layout.codedIndexSize("ResolutionScope"));
    readManagedValue(() => validateScopeChain(row), issues);
    const name = cursor.readIndex(layout.stringIndexSize);
    const namespace = cursor.readIndex(layout.stringIndexSize);
    return fullName(
      readMetadataString(bytes, layout, namespace, layout.strings.size),
      readMetadataString(bytes, layout, name, layout.strings.size),
    );
  };
  const specName = (row: number): string | null => {
    const cursor = metadataRowCursor(bytes, layout, 27, row);
    const spec = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      layout.blob.size,
    );
    const owner = {
      form: "type",
      scope: `metadata.TypeSpec:${metadataToken(27, row)}`,
      offset: cursor.start,
    } as const;
    specSignature(layout, spec, owner);
    if (spec[0] !== 0x15) return null;
    // GENERICINST (CLASS | VALUETYPE) TypeDefOrRefEncoded: never a TypeSpec,
    // so naming never recurses.
    const encoded = readCompressed(spec, 2).value;
    const table = ([2, 1] as const)[encoded & 3];
    if (table === undefined)
      throw managedFailure(
        "invalid-blob",
        owner.scope,
        "Generic instantiation does not name a TypeDef or TypeRef",
        owner.offset,
      );
    return definitionName(table, Math.floor(encoded / 4));
  };
  return (token) => {
    if (token === null) return null;
    if (names.has(token)) return names.get(token) ?? null;
    const table = Number.parseInt(token.slice(2, 4), 16);
    const row = Number.parseInt(token.slice(4), 16);
    const name =
      readManagedValue(
        () =>
          table === 27
            ? specName(row)
            : table === 1 || table === 2
              ? definitionName(table, row)
              : null,
        issues,
      ) ?? null;
    names.set(token, name);
    return name;
  };
};
