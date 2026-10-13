/** Physical facts for one entry in a Mach-O FAT architecture table. */
export interface FatSliceDeclaration {
  readonly index: number;
  readonly offset: number;
  readonly size: number;
  readonly alignmentExponent: number;
  readonly cpuType: number;
  readonly cpuSubtype: number;
}

export interface FatSliceRangeIssue {
  readonly category: "malformed" | "unsupported";
  readonly reason: string;
}

export type FatContainerHeader =
  | { readonly state: "not-fat" }
  | { readonly state: "needs-data"; readonly requiredBytes: number }
  | { readonly state: "malformed"; readonly reason: string }
  | {
      readonly state: "parsed";
      readonly magic: number;
      readonly count: number;
      readonly wide: boolean;
      readonly littleEndian: boolean;
      readonly tableEnd: number;
      readonly slices: readonly FatSliceDeclaration[];
      readonly rangeIssues: readonly (FatSliceRangeIssue | null)[];
    };

export type FatContainerIdentity =
  | { readonly state: "mach-o" }
  | { readonly state: "not-mach-o" }
  | {
      readonly state: "needs-slice-header";
      readonly offsets: readonly number[];
    }
  | {
      readonly state: "malformed";
      readonly category: "malformed" | "unsupported";
      readonly reason: string;
    };

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM = 0xbebafeca;
const FAT_CIGAM_64 = 0xbfbafeca;
const MAX_FAT_ARCHITECTURES = 128;
const KNOWN_MACHO_CPU_TYPES: readonly number[] = [
  7, 0x01000007, 12, 0x0100000c, 0x0200000c, 18, 0x01000012,
];
const MACHO_HEADER_MAGICS: readonly number[] = [
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
];

/** Parse a bounded FAT header and table without treating the magic alone as proof. */
export const readFatContainerHeader = (
  bytes: Uint8Array,
  fileSize: number,
): FatContainerHeader => {
  if (bytes.byteLength < 4) return { state: "not-fat" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (![FAT_MAGIC, FAT_MAGIC_64, FAT_CIGAM, FAT_CIGAM_64].includes(magic))
    return { state: "not-fat" };
  if (!Number.isSafeInteger(fileSize) || fileSize < bytes.byteLength)
    return {
      state: "malformed",
      reason: "FAT file size is invalid or contradicts retained bytes",
    };
  if (bytes.byteLength < 8) {
    return fileSize < 8
      ? { state: "malformed", reason: "FAT header is truncated" }
      : { state: "needs-data", requiredBytes: 8 };
  }
  const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
  const wide = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
  const count = view.getUint32(4, littleEndian);
  if (count === 0)
    return {
      state: "malformed",
      reason: "FAT header declares no architectures",
    };
  if (count > MAX_FAT_ARCHITECTURES) return { state: "not-fat" };
  const tableEnd = 8 + count * (wide ? 32 : 20);
  if (tableEnd > fileSize) return { state: "not-fat" };
  if (tableEnd > bytes.byteLength)
    return { state: "needs-data", requiredBytes: tableEnd };
  const declarations = readFatSliceDeclarations(bytes.subarray(8, tableEnd), {
    count,
    wide,
    littleEndian,
  });
  return declarations.status === "parsed"
    ? {
        state: "parsed",
        magic,
        count,
        wide,
        littleEndian,
        tableEnd,
        slices: declarations.slices,
        rangeIssues: declarations.slices.map((slice) =>
          inspectFatSliceRange(slice, fileSize, tableEnd),
        ),
      }
    : { state: "malformed", reason: declarations.reason };
};

/** Confirm FAT identity from architecture records and observed slice headers. */
export const classifyFatContainerIdentity = (
  header: Extract<FatContainerHeader, { readonly state: "parsed" }>,
  sliceHeaderAt: (offset: number) => number | null | undefined,
): FatContainerIdentity => {
  const hasKnownCpu = header.slices.some(({ cpuType }) =>
    KNOWN_MACHO_CPU_TYPES.includes(cpuType),
  );
  const invalidRange = header.rangeIssues.find(
    (issue): issue is FatSliceRangeIssue => issue !== null,
  );
  if (hasKnownCpu)
    return invalidRange === undefined
      ? { state: "mach-o" }
      : { state: "malformed", ...invalidRange };
  const validRanges = header.slices.filter(
    (_slice, index) => header.rangeIssues[index] === null,
  );
  const missingHeaders: number[] = [];
  let observedMachO = false;
  for (const slice of validRanges) {
    const magic = sliceHeaderAt(slice.offset);
    if (magic === undefined) missingHeaders.push(slice.offset);
    else if (magic !== null && MACHO_HEADER_MAGICS.includes(magic))
      observedMachO = true;
  }
  if (observedMachO) {
    return invalidRange === undefined
      ? { state: "mach-o" }
      : { state: "malformed", ...invalidRange };
  }
  if (missingHeaders.length > 0)
    return { state: "needs-slice-header", offsets: missingHeaders };
  return { state: "not-mach-o" };
};

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
  const rangeIssue = inspectFatSliceRange(declaration, containerSize, tableEnd);
  if (rangeIssue !== null) return rangeIssue.reason;
  return embedded === undefined
    ? null
    : validateFatSliceIdentity(declaration, embedded);
};

/** Validate table placement, container bounds, and alignment with a typed failure. */
export const inspectFatSliceRange = (
  declaration: FatSliceDeclaration,
  containerSize: number,
  tableEnd: number,
): FatSliceRangeIssue | null => {
  const { index, offset, size, alignmentExponent } = declaration;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    offset < tableEnd
  )
    return {
      category: "malformed",
      reason: `FAT architecture ${index} has an invalid slice range`,
    };
  if (offset > containerSize || size > containerSize - offset)
    return {
      category: "malformed",
      reason: `FAT architecture ${index} slice range extends beyond the file`,
    };
  if (
    !Number.isInteger(alignmentExponent) ||
    alignmentExponent < 0 ||
    alignmentExponent > 52
  )
    return {
      category: "unsupported",
      reason: `FAT architecture ${index} alignment exponent ${alignmentExponent} is unsupported`,
    };
  if (offset % 2 ** alignmentExponent !== 0)
    return {
      category: "malformed",
      reason: `FAT architecture ${index} offset is not aligned to 2^${alignmentExponent}`,
    };
  return null;
};

/** Validate only the identity claim after the owner has validated its range. */
export const validateFatSliceIdentity = (
  declaration: FatSliceDeclaration,
  embedded: { readonly cpuType: number; readonly cpuSubtype: number },
): string | null =>
  embedded.cpuType === declaration.cpuType &&
  embedded.cpuSubtype === declaration.cpuSubtype
    ? null
    : `FAT architecture ${declaration.index} CPU type/subtype disagrees with its Mach-O header`;

const safeNumber = (value: bigint): number | null =>
  value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
