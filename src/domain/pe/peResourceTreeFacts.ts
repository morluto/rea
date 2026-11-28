import { BinaryReader } from "../binaryContainer.js";

/** Fixed PE resource records; callers own interval, budget and tree admission. */
export const PE_RESOURCE_DIRECTORY_BYTES = 16;
export const PE_RESOURCE_ENTRY_BYTES = 8;
export const PE_RESOURCE_DATA_ENTRY_BYTES = 16;
export const PE_RESOURCE_NAME_PREFIX_BYTES = 2;
export const PE_RESOURCE_ENTRY_LIMIT = "max_entries";
/** `RT_RCDATA`, `MAKEINTRESOURCE(10)` in winuser.h: raw application data. */
export const PE_RESOURCE_TYPE_RCDATA = 10;

export const peResourceRangeFits = (
  offset: number,
  bytes: number,
  intervalBytes: number,
): boolean => offset >= 0 && offset <= intervalBytes - bytes;

/** Decode an already-admitted IMAGE_RESOURCE_DIRECTORY record. */
export const readPeResourceDirectoryFacts = (bytes: Buffer) => {
  const reader = new BinaryReader(bytes, true, "pe");
  const namedEntries = reader.u16(12);
  const idEntries = reader.u16(14);
  return {
    characteristics: reader.u32(0),
    timestamp: reader.u32(4),
    majorVersion: reader.u16(8),
    minorVersion: reader.u16(10),
    namedEntries,
    idEntries,
    entryCount: namedEntries + idEntries,
  };
};

export type PeResourceIdentityDeclaration =
  | { readonly kind: "id"; readonly id: number }
  | { readonly kind: "name"; readonly offset: number };

/** Offsets remain relative to the resource root; numeric IDs retain all source bits. */
export const readPeResourceEntryFacts = (bytes: Buffer) => {
  const reader = new BinaryReader(bytes, true, "pe");
  const encodedIdentity = reader.u32(0);
  const encodedTarget = reader.u32(4);
  const identity: PeResourceIdentityDeclaration =
    (encodedIdentity & 0x80000000) === 0
      ? { kind: "id", id: encodedIdentity }
      : { kind: "name", offset: encodedIdentity & 0x7fffffff };
  return {
    identity,
    target: {
      kind:
        (encodedTarget & 0x80000000) === 0
          ? ("data" as const)
          : ("directory" as const),
      offset: encodedTarget & 0x7fffffff,
    },
  };
};

/** Observe the length only; callers admit decoded-name costs before reading or decoding payload. */
export const readPeResourceNameFacts = (bytes: Buffer) => {
  const utf16Units = new BinaryReader(bytes, true, "pe").u16(0);
  return { utf16Units, payloadBytes: utf16Units * 2 };
};

/** Decode an already-admitted IMAGE_RESOURCE_DATA_ENTRY record. */
export const readPeResourceDataEntryFacts = (bytes: Buffer) => {
  const record = new BinaryReader(bytes, true, "pe");
  return {
    rva: record.u32(0),
    size: record.u32(4),
    codePage: record.u32(8),
    reserved: record.u32(12),
  };
};
