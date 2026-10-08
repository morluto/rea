/** Physical facts for one entry in a Mach-O FAT architecture table. */
export interface FatSliceDeclaration {
  readonly index: number;
  readonly offset: number;
  readonly size: number;
  readonly alignmentExponent: number;
  readonly cpuType: number;
  readonly cpuSubtype: number;
}

/** Decode FAT table entries once so artifact and native readers share identity facts. */
export const readFatSliceDeclarations = (
  tableBytes: Uint8Array,
  options: {
    readonly count: number;
    readonly wide: boolean;
    readonly littleEndian: boolean;
  },
):
  | {
      readonly status: "parsed";
      readonly slices: readonly FatSliceDeclaration[];
    }
  | { readonly status: "malformed"; readonly reason: string } => {
  const { count, wide, littleEndian } = options;
  const entrySize = wide ? 32 : 20;
  if (tableBytes.byteLength < count * entrySize)
    return { status: "malformed", reason: "FAT table is truncated" };
  const view = new DataView(
    tableBytes.buffer,
    tableBytes.byteOffset,
    tableBytes.byteLength,
  );
  const slices: FatSliceDeclaration[] = [];
  for (let index = 0; index < count; index++) {
    const base = index * entrySize;
    const offset = wide
      ? safeNumber(view.getBigUint64(base + 8, littleEndian))
      : view.getUint32(base + 8, littleEndian);
    const size = wide
      ? safeNumber(view.getBigUint64(base + 16, littleEndian))
      : view.getUint32(base + 12, littleEndian);
    if (offset === null || size === null)
      return {
        status: "malformed",
        reason: "FAT offset or size exceeds the safe range",
      };
    slices.push({
      index,
      offset,
      size,
      alignmentExponent: view.getUint32(base + (wide ? 24 : 16), littleEndian),
      cpuType: view.getUint32(base, littleEndian),
      cpuSubtype: view.getUint32(base + 4, littleEndian),
    });
  }
  return { status: "parsed", slices };
};

/** Validate byte-range and table/header identity facts shared by Mach-O readers. */
export const validateFatSlice = (
  declaration: FatSliceDeclaration,
  containerSize: number,
  tableEnd: number,
  embedded?: { readonly cpuType: number; readonly cpuSubtype: number },
): string | null => {
  const { index, offset, size, alignmentExponent, cpuType, cpuSubtype } =
    declaration;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    offset < tableEnd
  )
    return `FAT architecture ${index} has an invalid slice range`;
  if (offset > containerSize || size > containerSize - offset)
    return `FAT architecture ${index} slice range extends beyond the file`;
  if (
    !Number.isInteger(alignmentExponent) ||
    alignmentExponent < 0 ||
    alignmentExponent > 52
  )
    return `FAT architecture ${index} alignment exponent ${alignmentExponent} is unsupported`;
  if (offset % 2 ** alignmentExponent !== 0)
    return `FAT architecture ${index} offset is not aligned to 2^${alignmentExponent}`;
  if (
    embedded !== undefined &&
    (embedded.cpuType !== cpuType || embedded.cpuSubtype !== cpuSubtype)
  )
    return `FAT architecture ${index} CPU type/subtype disagrees with its Mach-O header`;
  return null;
};

const safeNumber = (value: bigint): number | null =>
  value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
