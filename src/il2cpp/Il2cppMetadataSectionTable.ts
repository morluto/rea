import { BinaryReader } from "../domain/binaryContainer.js";
import { IL2CPP_METADATA_PREFIX_BYTES } from "../domain/il2cpp/il2cppMetadataHeaderPrefix.js";
import { IL2CPP_METADATA_FORMAT } from "./Il2cppMetadataFormat.js";

interface SectionDeclaration<Name extends string = string> {
  readonly name: Name;
  readonly offset: number;
  readonly size: number;
  readonly count: number | null;
}

/** Section table framing, after the owner of the header layout admits its extent. */
export function readIl2cppSectionTable<Name extends string>(
  bytes: Buffer,
  names: readonly Name[],
  entryBytes: 12,
): Array<SectionDeclaration<Name> & { readonly count: number }>;
export function readIl2cppSectionTable<Name extends string>(
  bytes: Buffer,
  names: readonly Name[],
  entryBytes: 8 | 12,
): Array<SectionDeclaration<Name>>;
export function readIl2cppSectionTable<Name extends string>(
  bytes: Buffer,
  names: readonly Name[],
  entryBytes: 8 | 12,
): Array<SectionDeclaration<Name>> {
  const reader = new BinaryReader(bytes, true, IL2CPP_METADATA_FORMAT);
  return names.map((name, index) => {
    const at = IL2CPP_METADATA_PREFIX_BYTES + index * entryBytes;
    return {
      name,
      offset: reader.i32(at),
      size: reader.i32(at + 4),
      count: entryBytes === 12 ? reader.i32(at + 8) : null,
    };
  });
}

type SectionIssue =
  | { readonly kind: "range" | "header"; readonly section: SectionDeclaration }
  | {
      readonly kind: "overlap";
      readonly previous: SectionDeclaration;
      readonly current: SectionDeclaration;
    };

/** Shared geometry for counted and fixed tables. Layout-specific rules stay with their callers. */
export const firstIl2cppSectionIssue = (
  sections: readonly SectionDeclaration[],
  headerBytes: number,
  fileBytes: number,
): SectionIssue | undefined => {
  for (const section of sections) {
    if (
      section.offset < 0 ||
      section.size < 0 ||
      (section.count ?? 0) < 0 ||
      section.offset + section.size > fileBytes
    )
      return { kind: "range", section };
    if (section.size > 0 && section.offset < headerBytes)
      return { kind: "header", section };
  }
  // Empty sections may share offsets with their neighbors.
  const occupied = sections
    .filter((section) => section.size > 0)
    .sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < occupied.length; index++) {
    const previous = occupied[index - 1]!;
    const current = occupied[index]!;
    if (previous.offset + previous.size > current.offset)
      return { kind: "overlap", previous, current };
  }
  return undefined;
};
