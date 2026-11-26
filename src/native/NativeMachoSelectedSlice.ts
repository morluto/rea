import {
  readFatHeaderPrefix,
  readFatSliceDeclarations,
  validateFatSlice,
  type FatSliceDeclaration,
} from "../domain/apple/machoContainer.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
} from "../domain/parseFailure.js";
import type { MachoCommandNames } from "../domain/apple/machoCommandNames.js";
import type { NativeMachoSource } from "./NativeMachoSource.js";
import {
  lipoDescribesCpu,
  type LipoArchitecture,
} from "../domain/apple/lipo.js";

export interface ResolvedMachoSlice {
  readonly offset: number;
  readonly size: number;
  readonly declaration: FatSliceDeclaration;
  readonly tableEnd: number;
}

/** Resolve a unique FAT declaration without replacing observed lipo facts. */
export const resolveSelectedMachoSlice = async (
  source: NativeMachoSource,
  selected: LipoArchitecture,
  maximumRecords: number,
): Promise<ResolvedMachoSlice> => {
  if (
    selected.cpu_type_code === null &&
    (selected.file_offset === null || selected.size === null)
  )
    throw malformedInput(
      "macho",
      "Selected Mach-O slice CPU identity is unavailable",
    );
  const prefix = readFatHeaderPrefix(
    await source.readSlice(0, source.bytes, 0, Math.min(8, source.bytes)),
  );
  if (prefix.state !== "parsed")
    throw malformedInput(
      "macho",
      "Selected Mach-O universal header is unavailable",
    );
  const rows = prefix.count + (selected.hidden ? 1 : 0);
  if (rows > maximumRecords)
    throw decodeLimit(
      "macho",
      "Mach-O FAT slice records exceed the selected-slice table budget",
      { name: "macho_fat_slice_records", maximum: maximumRecords },
    );
  const entrySize = prefix.wide ? 32 : 20;
  const tableEnd = 8 + rows * entrySize;
  if (tableEnd > source.bytes)
    throw truncatedInput(
      "macho",
      `Selected Mach-O universal table is truncated: the file has ${source.bytes} bytes and the table needs ${tableEnd}`,
      { extent: { availableBytes: source.bytes, requiredBytes: tableEnd } },
    );
  const matches: FatSliceDeclaration[] = [];
  const declarations: FatSliceDeclaration[] = [];
  for (let first = 0; first < rows; first += 256) {
    const count = Math.min(256, rows - first);
    const raw = await source.readSlice(
      0,
      source.bytes,
      8 + first * entrySize,
      count * entrySize,
    );
    const parsed = readFatSliceDeclarations(raw, {
      count,
      wide: prefix.wide,
      littleEndian: prefix.littleEndian,
    });
    if (parsed.status !== "parsed")
      throw malformedInput("macho", parsed.reason);
    for (const row of parsed.slices) {
      declarations.push(row);
      if (
        (selected.file_offset !== null &&
          row.offset !== selected.file_offset) ||
        (selected.size !== null && row.size !== selected.size) ||
        !lipoDescribesCpu(selected, row.cpuType, row.cpuSubtype) ||
        (selected.alignment !== null &&
          selected.alignment !== 2 ** row.alignmentExponent)
      )
        continue;
      matches.push(row);
    }
  }
  if (matches.length !== 1)
    throw malformedInput(
      "macho",
      "Selected lipo slice does not identify exactly one FAT entry",
    );
  const declaration = matches[0]!;
  if (
    declarations.some(
      (row) =>
        row !== declaration &&
        row.offset < declaration.offset + declaration.size &&
        declaration.offset < row.offset + row.size,
    )
  )
    throw malformedInput(
      "macho",
      "Selected Mach-O slice overlaps another FAT entry",
    );
  return {
    offset: declaration.offset,
    size: declaration.size,
    declaration,
    tableEnd,
  };
};

/** Bind the selected FAT declaration to the admitted thin header. */
export const assertSelectedMachoSlice = (
  source: NativeMachoSource,
  selected: ResolvedMachoSlice,
  binary: MachoCommandNames,
): void => {
  const failure = validateFatSlice(
    selected.declaration,
    source.bytes,
    selected.tableEnd,
    binary.header,
  );
  if (failure !== null) throw malformedInput("macho", failure);
};
