import { BinaryReader } from "../domain/binaryContainer.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataToken,
  readRequiredMetadataName,
} from "../domain/managed/managedMetadataHeaps.js";

/** Meaning of the MethodDef implementation bits, independent of RVA or ImplMap evidence. */
export interface ManagedMethodImplementationFlags {
  readonly codeType: "il" | "native" | "optil" | "runtime";
  readonly managedKind: "managed" | "unmanaged";
  readonly pinvokeFlag: boolean;
  /** MethodImplOptions.InternalCall (0x1000): the runtime implements the body. */
  readonly internalCall: boolean;
}

const METHOD_CODE_TYPES = ["il", "native", "optil", "runtime"] as const;

/** Scalar MethodDef facts; consumers own heap admission and method selection. */
export const readMethodDefinitionRow = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
): {
  readonly token: string;
  readonly rowOffset: number;
  readonly rva: number;
  readonly implFlags: number;
  readonly flags: number;
  readonly nameIndex: number;
  readonly nameOffset: number;
  readonly signatureIndex: number;
  readonly implementation: ManagedMethodImplementationFlags;
} => {
  // Layout admission bounds the whole fixed-width row before a cursor is created.
  const cursor = metadataRowCursor(bytes, layout, 6, row);
  const rva = cursor.u32();
  const implFlags = cursor.u16();
  const flags = cursor.u16();
  return {
    token: metadataToken(6, row),
    rowOffset: cursor.start,
    rva,
    implFlags,
    flags,
    nameOffset: cursor.offset,
    nameIndex: cursor.readIndex(layout.stringIndexSize),
    signatureIndex: cursor.readIndex(layout.blobIndexSize),
    implementation: {
      codeType: METHOD_CODE_TYPES[(implFlags & 0x0003) as 0 | 1 | 2 | 3],
      managedKind: (implFlags & 0x0004) === 0 ? "managed" : "unmanaged",
      pinvokeFlag: (flags & 0x2000) !== 0,
      internalCall: (implFlags & 0x1000) !== 0,
    },
  };
};

/**
 * The raw first ParamList coordinate of a MethodDef row. Attributing one
 * method's run reads every row's coordinate, so this reads the admitted table
 * extent directly instead of retaining per-row cursor bookkeeping for rows the
 * caller did not select.
 */
export const readMethodParamList = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  row: number,
): { readonly raw: number; readonly offset: number } => {
  // The admitted MethodDef row size gives ParamList a Param-table index width.
  const offset =
    metadataRowOffset(layout, 6, row) +
    8 +
    layout.stringIndexSize +
    layout.blobIndexSize;
  const reader = new BinaryReader(bytes, true, "managed");
  return {
    raw:
      layout.tableIndexSize(8) === 2 ? reader.u16(offset) : reader.u32(offset),
    offset,
  };
};

export const readMethodDefinitionName = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  definition: Pick<
    ReturnType<typeof readMethodDefinitionRow>,
    "token" | "nameIndex" | "nameOffset"
  >,
): string =>
  readRequiredMetadataName(
    bytes,
    layout,
    "MethodDef",
    definition.token,
    definition,
  );
