import { z } from "zod";

import { byteToHex } from "../kernel/byteToHex.js";
import { readUint16At, readUint32At } from "./binaryContainer.js";
import { Budget } from "./budget.js";
import { decodeLimit, malformedInput, truncatedInput } from "./parseFailure.js";
import { isPortablePathSegment } from "./portablePathSegment.js";
import { offset, uint16, uint32, uint8 } from "./formatMetadata/primitives.js";

/**
 * Nintendo DS cartridge ROM (`.nds`) layout, as documented by GBATEK "DS
 * Cartridge Header" and "DS Cartridge NitroROM and NitroARC File Systems".
 * The format has no magic; a header is claimed by its stored logo CRC and a
 * checksum over the header itself.
 */
export const NDS_FORMAT = "nds";

/** Bytes of the cartridge header REA reads. */
export const NDS_HEADER_BYTES = 0x200;
/** The header checksum covers bytes 0x000 through 0x15D. */
const HEADER_CRC_OFFSET = 0x15e;
const LOGO_OFFSET = 0xc0;
const LOGO_CRC_OFFSET = 0x15c;
/** Bytes a recognizer needs: everything through the header CRC field. */
export const NDS_RECOGNITION_BYTES = HEADER_CRC_OFFSET + 2;
/** CRC16 of the fixed boot logo every licensed and homebrew header carries. */
export const NDS_LOGO_CRC = 0xcf56;

/** File IDs below 0xF000 name files; 0xF000-0xFFFF name directories. */
const FIRST_DIRECTORY_ID = 0xf000;
/** Format ceilings derived from the 16-bit ID space, not tunable budgets. */
export const NDS_MAX_FILES = FIRST_DIRECTORY_ID;
export const NDS_MAX_DIRECTORIES = 0x1_0000 - FIRST_DIRECTORY_ID;
const FAT_ENTRY_BYTES = 8;
const OVERLAY_ENTRY_BYTES = 32;
const FNT_MAIN_ENTRY_BYTES = 8;
/** Longest FNT name: the type/length byte keeps seven bits of length. */
const MAX_NAME_BYTES = 0x7f;
export const NDS_MAX_FAT_BYTES = NDS_MAX_FILES * FAT_ENTRY_BYTES;
export const NDS_MAX_OVERLAY_TABLE_BYTES = NDS_MAX_FILES * OVERLAY_ENTRY_BYTES;
/**
 * The largest FNT the ID space can describe: every directory's main entry,
 * every file and directory name at full length, and one terminator per
 * directory.
 */
export const NDS_MAX_FNT_BYTES =
  NDS_MAX_DIRECTORIES * FNT_MAIN_ENTRY_BYTES +
  NDS_MAX_FILES * (1 + MAX_NAME_BYTES) +
  NDS_MAX_DIRECTORIES * (1 + MAX_NAME_BYTES + 2) +
  NDS_MAX_DIRECTORIES;
/** Maximum FNT directory nesting depth admitted from the root. */
export const NDS_MAX_DIRECTORY_DEPTH = 64;
/**
 * Maximum aggregate UTF-8 bytes of expanded member paths retained by
 * {@link parseNdsLayout}, charged before allocating or retaining each path.
 */
export const NDS_MAX_PATH_BYTES = 16 * 1024 * 1024;
export const NDS_DIRECTORY_DEPTH_LIMIT = "nds.directory_depth";
export const NDS_PATH_BYTES_LIMIT = "nds.path_bytes";

/** Bounds on expanded FNT paths retained during {@link parseNdsLayout}. */
export interface NdsLayoutLimits {
  readonly maxDirectoryDepth?: number;
  readonly maxPathBytes?: number;
}

/** CRC-16/MODBUS (reflected polynomial 0xA001, initial 0xFFFF). */
export const ndsCrc16 = (bytes: Uint8Array): number => {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
};

const UNIT_CODES = { 0: "nds", 2: "nds-dsi", 3: "dsi" } as const;

/**
 * Whether the leading bytes hold a DS cartridge header: the stored logo CRC
 * is 0xCF56, the unit code is one the format defines, the ARM9 binary starts
 * after the header, and either the logo area or the header checksum agrees
 * with its stored CRC. A header whose own checksum disagrees is still
 * claimed when the logo matches; inventory reports the mismatch.
 */
export const hasNdsHeader = (prefix: Uint8Array): boolean => {
  if (prefix.length < NDS_RECOGNITION_BYTES) return false;
  if (readUint16At(prefix, LOGO_CRC_OFFSET, true) !== NDS_LOGO_CRC)
    return false;
  if (!Object.hasOwn(UNIT_CODES, prefix[0x12]!)) return false;
  if (readUint32At(prefix, 0x20, true) < NDS_HEADER_BYTES) return false;
  return (
    ndsCrc16(prefix.subarray(LOGO_OFFSET, LOGO_CRC_OFFSET)) === NDS_LOGO_CRC ||
    ndsCrc16(prefix.subarray(0, HEADER_CRC_OFFSET)) ===
      readUint16At(prefix, HEADER_CRC_OFFSET, true)
  );
};

const binarySchema = z.strictObject({
  rom_offset: uint32,
  entry_address: uint32,
  ram_address: uint32,
  size: uint32,
});
const tableSchema = z.strictObject({ offset: uint32, length: uint32 });
const crcSchema = z.strictObject({ declared: uint16, computed: uint16 });

/** Cartridge header facts as declared, with both CRC results. */
export const ndsMetadataSchema = z.strictObject({
  kind: z.literal("nds"),
  /**
   * Up to 12 printable ASCII characters before the first NUL; unprintable
   * bytes appear as `?` and any lossy decoding (unprintable bytes before the
   * first NUL or non-zero bytes after it) is reported in limitations with the
   * raw bytes.
   */
  title: z.string(),
  game_code: z.string(),
  maker_code: z.string(),
  unit_code: uint8,
  /** `nds`, `nds-dsi` or `dsi`, from the unit code. */
  unit: z.enum(["nds", "nds-dsi", "dsi"]),
  device_capacity: uint8,
  rom_version: uint8,
  arm9: binarySchema,
  arm7: binarySchema,
  fnt: tableSchema,
  fat: tableSchema,
  arm9_overlay_table: tableSchema,
  arm7_overlay_table: tableSchema,
  banner_offset: uint32,
  total_used_rom_size: uint32,
  header_size: uint32,
  logo_crc: crcSchema,
  header_crc: crcSchema,
  /** FAT entries examined; each is one file ID. */
  file_count: offset,
  /** FNT directories reached from the root. */
  directory_count: offset,
  arm9_overlay_count: offset,
  arm7_overlay_count: offset,
});
export type NdsMetadata = z.infer<typeof ndsMetadataSchema>;

const overlaySchema = z.strictObject({
  overlay_id: uint32,
  ram_address: uint32,
  ram_size: uint32,
  bss_size: uint32,
  static_init_start: uint32,
  static_init_end: uint32,
  /** The word after the file ID; newer SDKs keep compression flags here. */
  flags: uint32,
});
export type NdsOverlay = z.infer<typeof overlaySchema>;

/** One listed byte range: a CPU binary, an overlay file or a filesystem file. */
export const ndsEntryMetadataSchema = z.strictObject({
  kind: z.literal("nds-entry"),
  role: z.enum(["arm9", "arm7", "arm9-overlay", "arm7-overlay", "file"]),
  /** FAT file ID; null for the ARM9 and ARM7 binaries. */
  file_id: uint16.nullable(),
  /** RAM load and entry addresses the header declares for a CPU binary. */
  ram_address: uint32.nullable(),
  entry_address: uint32.nullable(),
  overlay: overlaySchema.nullable(),
});
export type NdsEntryMetadata = z.infer<typeof ndsEntryMetadataSchema>;

/** A byte range of the ROM file and what it holds. */
export interface NdsRegion {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly metadata: NdsEntryMetadata;
}

/** The header facts and where its tables lie. */
export interface NdsHeader {
  readonly metadata: Omit<
    NdsMetadata,
    | "file_count"
    | "directory_count"
    | "arm9_overlay_count"
    | "arm7_overlay_count"
  >;
  readonly limitations: readonly string[];
}

const hex16 = (value: number): string =>
  `0x${value.toString(16).padStart(4, "0")}`;

const ascii = (
  header: Uint8Array,
  field: string,
  at: number,
  length: number,
  limitations: string[],
): string => {
  const bytes = header.subarray(at, at + length);
  let text = "";
  let seenNul = false;
  let lossy = false;
  for (const byte of bytes) {
    if (seenNul) {
      if (byte !== 0) lossy = true;
      continue;
    }
    if (byte === 0) {
      seenNul = true;
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
    else {
      text += "?";
      lossy = true;
    }
  }
  if (lossy) {
    const raw = Array.from(bytes, byteToHex).join(" ");
    limitations.push(
      `DS header ${field} at ${hex16(at)} is not clean NUL-padded ASCII; raw bytes ${raw}; the shown text replaces unprintable bytes with ? and drops bytes after the first NUL.`,
    );
  }
  return text;
};

const binaryAt = (header: Uint8Array, at: number) => ({
  rom_offset: readUint32At(header, at, true),
  entry_address: readUint32At(header, at + 4, true),
  ram_address: readUint32At(header, at + 8, true),
  size: readUint32At(header, at + 12, true),
});
const tableAt = (header: Uint8Array, at: number) => ({
  offset: readUint32At(header, at, true),
  length: readUint32At(header, at + 4, true),
});

/** Interpret the cartridge header. CRC disagreements and lossy text fields are limitations. */
export const parseNdsHeader = (header: Uint8Array): NdsHeader => {
  if (header.length < NDS_RECOGNITION_BYTES)
    throw truncatedInput(
      NDS_FORMAT,
      `DS cartridge header needs ${String(NDS_RECOGNITION_BYTES)} bytes; the file has ${String(header.length)}`,
      {
        offset: 0,
        field: "header",
        extent: {
          availableBytes: header.length,
          requiredBytes: NDS_RECOGNITION_BYTES,
        },
      },
    );
  const unitCode = header[0x12]!;
  const unit = UNIT_CODES[unitCode as keyof typeof UNIT_CODES] as
    | NdsMetadata["unit"]
    | undefined;
  if (unit === undefined)
    throw malformedInput(
      NDS_FORMAT,
      `DS cartridge unit code ${String(unitCode)} is not 0, 2 or 3`,
      { offset: 0x12, field: "unit_code" },
    );
  const logoCrc = {
    declared: readUint16At(header, LOGO_CRC_OFFSET, true),
    computed: ndsCrc16(header.subarray(LOGO_OFFSET, LOGO_CRC_OFFSET)),
  };
  const headerCrc = {
    declared: readUint16At(header, HEADER_CRC_OFFSET, true),
    computed: ndsCrc16(header.subarray(0, HEADER_CRC_OFFSET)),
  };
  const limitations: string[] = [];
  if (logoCrc.declared !== logoCrc.computed)
    limitations.push(
      `DS logo CRC does not match: declared ${hex16(logoCrc.declared)}, computed ${hex16(logoCrc.computed)}.`,
    );
  if (headerCrc.declared !== headerCrc.computed)
    limitations.push(
      `DS header CRC does not match: declared ${hex16(headerCrc.declared)}, computed ${hex16(headerCrc.computed)}; header fields may be corrupt.`,
    );
  const title = ascii(header, "title", 0x00, 12, limitations);
  const gameCode = ascii(header, "game_code", 0x0c, 4, limitations);
  const makerCode = ascii(header, "maker_code", 0x10, 2, limitations);
  return {
    metadata: {
      kind: "nds",
      title,
      game_code: gameCode,
      maker_code: makerCode,
      unit_code: unitCode,
      unit,
      device_capacity: header[0x14]!,
      rom_version: header[0x1e]!,
      arm9: binaryAt(header, 0x20),
      arm7: binaryAt(header, 0x30),
      fnt: tableAt(header, 0x40),
      fat: tableAt(header, 0x48),
      arm9_overlay_table: tableAt(header, 0x50),
      arm7_overlay_table: tableAt(header, 0x58),
      banner_offset: readUint32At(header, 0x68, true),
      total_used_rom_size: readUint32At(header, 0x80, true),
      header_size: readUint32At(header, 0x84, true),
      logo_crc: logoCrc,
      header_crc: headerCrc,
    },
    limitations,
  };
};

/** Table bytes the reader loaded; `undefined` when the table was not read. */
export interface NdsTables {
  readonly fnt: Uint8Array | undefined;
  readonly fat: Uint8Array | undefined;
  readonly arm9Overlays: Uint8Array | undefined;
  readonly arm7Overlays: Uint8Array | undefined;
}

/**
 * Which part of a table the reader may load: the declared range clamped to
 * the file and to the format's ceiling. An empty table and a range that
 * starts past the file are not read.
 */
export const ndsTableReadRange = (
  name: string,
  table: { readonly offset: number; readonly length: number },
  fileSize: number,
  ceiling: number,
):
  | {
      readonly offset: number;
      readonly length: number;
      readonly limitations: readonly string[];
    }
  | { readonly offset: undefined; readonly limitations: readonly string[] } => {
  // An empty table holds nothing to read or omit, wherever it is declared.
  if (table.length === 0) return { offset: undefined, limitations: [] };
  if (table.offset >= fileSize)
    return {
      offset: undefined,
      limitations: [
        `DS ${name} at ${String(table.offset)} starts past the ${String(fileSize)}-byte file; it was not read.`,
      ],
    };
  const limitations: string[] = [];
  let length = table.length;
  if (table.offset + length > fileSize) {
    length = fileSize - table.offset;
    limitations.push(
      `DS ${name} declares ${String(table.length)} bytes at ${String(table.offset)} but the file ends after ${String(length)}; the remainder was not read.`,
    );
  }
  if (length > ceiling) {
    limitations.push(
      `DS ${name} declares ${String(table.length)} bytes, more than the ${String(ceiling)} the 16-bit file ID space can describe; only the first ${String(ceiling)} were read.`,
    );
    length = ceiling;
  }
  return { offset: table.offset, length, limitations };
};

interface FatRange {
  readonly start: number;
  readonly end: number;
}

/** What inventory lists and how much of the ROM it established. */
export interface NdsLayout {
  readonly metadata: NdsMetadata;
  readonly regions: readonly NdsRegion[];
  readonly limitations: readonly string[];
  /** False once a limitation is recorded. An empty table is not one. */
  readonly complete: boolean;
}

const isSafeName = (name: string): boolean =>
  /^[\x20-\x7e]+$/u.test(name) && isPortablePathSegment(name);

/**
 * Itemized limitations per repeated kind (bad FAT entry, unsafe name, ...).
 * Further ones of that kind are counted in one line, so a hostile table
 * cannot grow the report with its entry count.
 */
export const NDS_LIMITATION_EXAMPLES = 8;

/**
 * Interpret the FAT, the FNT directory tree and both overlay tables, and
 * list every byte range. Ranges that fall outside the file, unreadable names,
 * directory loops and a file ID claimed by more than one entry are
 * limitations; the affected entries are omitted or listed by file ID instead.
 */
export const parseNdsLayout = (
  header: NdsHeader,
  tables: NdsTables,
  fileSize: number,
  tableLimitations: readonly string[] = [],
  limits?: NdsLayoutLimits,
): NdsLayout => {
  const maxDirectoryDepth =
    limits?.maxDirectoryDepth ?? NDS_MAX_DIRECTORY_DEPTH;
  const maxPathBytes = limits?.maxPathBytes ?? NDS_MAX_PATH_BYTES;
  const pathBudget = new Budget(maxPathBytes);
  const chargePath = (pathBytes: number): void => {
    pathBudget.charge(pathBytes, () =>
      decodeLimit(
        NDS_FORMAT,
        `DS ROM expanded member paths exceed the ${String(maxPathBytes)}-byte allowance.`,
        {
          name: NDS_PATH_BYTES_LIMIT,
          maximum: maxPathBytes,
          required: pathBudget.used + pathBytes,
        },
        { field: "fnt" },
      ),
    );
  };
  const limitations = [...header.limitations, ...tableLimitations];
  // A failed header checksum, or a table left unread, is already a limitation.
  let complete = limitations.length === 0;
  const incomplete = (message: string) => {
    limitations.push(message);
    complete = false;
  };
  const repeated = new Map<string, number>();
  const note = (kind: string, message: string) => {
    complete = false;
    const count = (repeated.get(kind) ?? 0) + 1;
    repeated.set(kind, count);
    if (count <= NDS_LIMITATION_EXAMPLES) limitations.push(message);
  };
  const regions: NdsRegion[] = [];
  const { metadata } = header;

  for (const [role, binary] of [
    ["arm9", metadata.arm9],
    ["arm7", metadata.arm7],
  ] as const) {
    if (binary.rom_offset + binary.size > fileSize) {
      incomplete(
        `DS ${role.toUpperCase()} binary at ${String(binary.rom_offset)} (${String(binary.size)} bytes) ends past the ${String(fileSize)}-byte file; it is not listed.`,
      );
      continue;
    }
    const path = `${role}.bin`;
    chargePath(path.length);
    regions.push({
      path,
      offset: binary.rom_offset,
      length: binary.size,
      metadata: {
        kind: "nds-entry",
        role,
        file_id: null,
        ram_address: binary.ram_address,
        entry_address: binary.entry_address,
        overlay: null,
      },
    });
  }

  // FAT: one [start, end) pair per file ID.
  const fat: (FatRange | undefined)[] = [];
  if (tables.fat !== undefined) {
    if (tables.fat.length % FAT_ENTRY_BYTES !== 0)
      incomplete(
        `DS FAT is ${String(tables.fat.length)} bytes, not a multiple of ${String(FAT_ENTRY_BYTES)}; the trailing bytes were ignored.`,
      );
    for (
      let at = 0;
      at + FAT_ENTRY_BYTES <= tables.fat.length;
      at += FAT_ENTRY_BYTES
    ) {
      const id = at / FAT_ENTRY_BYTES;
      const start = readUint32At(tables.fat, at, true);
      const end = readUint32At(tables.fat, at + 4, true);
      if (end < start || end > fileSize) {
        note(
          "FAT entry",
          `DS FAT entry ${String(id)} spans ${String(start)}-${String(end)}, outside the ${String(fileSize)}-byte file; file ${String(id)} is not listed.`,
        );
        fat.push(undefined);
      } else fat.push({ start, end });
    }
  }
  const claimed = new Set<number>();
  const fileRegion = (
    id: number,
    path: string,
    role: NdsEntryMetadata["role"],
    overlay: NdsOverlay | null,
  ): void => {
    const range = fat[id];
    // Callers skip an id that another entry already claimed, and say why. An
    // invalid FAT range was reported when the table was read.
    if (range === undefined) return;
    claimed.add(id);
    regions.push({
      path,
      offset: range.start,
      length: range.end - range.start,
      metadata: {
        kind: "nds-entry",
        role,
        file_id: id,
        ram_address: null,
        entry_address: null,
        overlay,
      },
    });
  };

  // Overlay tables name FAT files by ID.
  const overlayCounts = { arm9: 0, arm7: 0 };
  for (const [cpu, bytes] of [
    ["arm9", tables.arm9Overlays],
    ["arm7", tables.arm7Overlays],
  ] as const) {
    if (bytes === undefined) continue;
    if (bytes.length % OVERLAY_ENTRY_BYTES !== 0)
      incomplete(
        `DS ${cpu.toUpperCase()} overlay table is ${String(bytes.length)} bytes, not a multiple of ${String(OVERLAY_ENTRY_BYTES)}; the trailing bytes were ignored.`,
      );
    const seen = new Set<number>();
    for (
      let at = 0;
      at + OVERLAY_ENTRY_BYTES <= bytes.length;
      at += OVERLAY_ENTRY_BYTES
    ) {
      overlayCounts[cpu] += 1;
      const overlay: NdsOverlay = {
        overlay_id: readUint32At(bytes, at, true),
        ram_address: readUint32At(bytes, at + 4, true),
        ram_size: readUint32At(bytes, at + 8, true),
        bss_size: readUint32At(bytes, at + 12, true),
        static_init_start: readUint32At(bytes, at + 16, true),
        static_init_end: readUint32At(bytes, at + 20, true),
        flags: readUint32At(bytes, at + 28, true),
      };
      const fileId = readUint32At(bytes, at + 24, true);
      if (seen.has(overlay.overlay_id)) {
        note(
          "overlay entry",
          `DS ${cpu.toUpperCase()} overlay ${String(overlay.overlay_id)} is declared more than once; only the first is listed.`,
        );
        continue;
      }
      seen.add(overlay.overlay_id);
      if (fileId >= fat.length || fat[fileId] === undefined)
        note(
          "overlay entry",
          `DS ${cpu.toUpperCase()} overlay ${String(overlay.overlay_id)} names file ${String(fileId)}, which has no valid FAT entry; it is not listed.`,
        );
      else if (claimed.has(fileId))
        note(
          "overlay entry",
          `DS ${cpu.toUpperCase()} overlay ${String(overlay.overlay_id)} names file ${String(fileId)}, which another entry already claimed; it is not listed.`,
        );
      else {
        const overlayPath = `overlays/${cpu}/overlay_${String(overlay.overlay_id).padStart(4, "0")}.bin`;
        chargePath(overlayPath.length);
        fileRegion(fileId, overlayPath, `${cpu}-overlay`, overlay);
      }
    }
  }

  // FNT: walk the directory tree from the root, refusing revisits. Valid
  // subtables are disjoint, so scanning more bytes than the table holds means
  // directories share or overlap subtables; the walk stops there.
  let directoryCount = 0;
  const fnt = tables.fnt;
  if (fnt !== undefined && fnt.length > 0) {
    if (fnt.length < FNT_MAIN_ENTRY_BYTES)
      incomplete(
        "DS FNT is shorter than its root directory entry; no names were read.",
      );
    else {
      const declaredDirectories = readUint16At(fnt, 6, true);
      const mainTableBytes = declaredDirectories * FNT_MAIN_ENTRY_BYTES;
      const presentDirectories = Math.floor(fnt.length / FNT_MAIN_ENTRY_BYTES);
      if (mainTableBytes > fnt.length) {
        const missingDirectories = declaredDirectories - presentDirectories;
        incomplete(
          `DS FNT main table is missing ${String(missingDirectories)} of its ${String(declaredDirectories)} declared directory rows.`,
        );
      }
      if (readUint32At(fnt, 0, true) < mainTableBytes)
        note(
          "FNT subtable",
          "DS FNT root subtable starts inside the declared main table.",
        );
      const walkableDirectories = Math.min(
        declaredDirectories,
        presentDirectories,
        NDS_MAX_DIRECTORIES,
      );
      const visited = new Set<number>();
      const pending: { id: number; path: string; depth: number }[] = [
        { id: FIRST_DIRECTORY_ID, path: "", depth: 0 },
      ];
      let scanned = 0;
      walk: while (pending.length > 0) {
        const { id, path, depth } = pending.pop()!;
        const index = id - FIRST_DIRECTORY_ID;
        if (visited.has(id)) {
          note(
            "FNT directory",
            `DS FNT directory ${String(id)} is reached more than once (a loop or shared subdirectory); only its first path is listed.`,
          );
          continue;
        }
        visited.add(id);
        if (index >= walkableDirectories) {
          note(
            "FNT directory",
            `DS FNT directory ${String(id)} at /${path} has no usable main-table row; its contents are not listed.`,
          );
          continue;
        }
        const main = index * FNT_MAIN_ENTRY_BYTES;
        directoryCount += 1;
        let at = readUint32At(fnt, main, true);
        let fileId = readUint16At(fnt, main + 4, true);
        const names = new Set<string>();
        for (;;) {
          if (at >= fnt.length) {
            note(
              "FNT subtable",
              `DS FNT subtable for directory ${String(id)} runs past the table; its remaining names are not listed.`,
            );
            break;
          }
          const type = fnt[at]!;
          const length = type & 0x7f;
          const isDirectory = type > 0x80;
          const end =
            type === 0 ? at + 1 : at + 1 + length + (isDirectory ? 2 : 0);
          scanned += end - at;
          if (scanned > fnt.length) {
            incomplete(
              `DS FNT subtables overlap: walking them reads more than the ${String(fnt.length)}-byte table; directories after ${String(directoryCount)} are not listed.`,
            );
            break walk;
          }
          if (type === 0) break;
          if (type === 0x80) {
            note(
              "FNT subtable",
              `DS FNT directory ${String(id)} uses reserved entry type 0x80; its remaining names are not listed.`,
            );
            break;
          }
          if (end > fnt.length) {
            note(
              "FNT subtable",
              `DS FNT entry in directory ${String(id)} runs past the table; its remaining names are not listed.`,
            );
            break;
          }
          const raw = fnt.subarray(at + 1, at + 1 + length);
          const name = Buffer.from(raw).toString("latin1");
          const safe = isSafeName(name) && !names.has(name);
          if (!safe)
            note(
              "FNT name",
              names.has(name)
                ? `DS FNT directory ${String(id)} names ${JSON.stringify(name)} twice; the later entry is listed by file ID.`
                : `DS FNT name ${JSON.stringify(name)} in directory ${String(id)} is not a portable path segment; it is listed by file ID.`,
            );
          names.add(name);
          const childBytes =
            path === "" ? name.length : path.length + 1 + name.length;
          if (isDirectory) {
            const childId = readUint16At(fnt, at + 1 + length, true);
            if (childId < FIRST_DIRECTORY_ID)
              note(
                "FNT subdirectory",
                `DS FNT subdirectory ${JSON.stringify(name)} names ID ${String(childId)}, which is not a directory ID; it is not listed.`,
              );
            else if (safe) {
              const childDepth = depth + 1;
              if (childDepth > maxDirectoryDepth)
                throw decodeLimit(
                  NDS_FORMAT,
                  `DS FNT directory depth exceeds the ${String(maxDirectoryDepth)}-level allowance.`,
                  {
                    name: NDS_DIRECTORY_DEPTH_LIMIT,
                    maximum: maxDirectoryDepth,
                    required: childDepth,
                  },
                  { field: "fnt" },
                );
              // Bound a single directory prefix before allocating it.
              if (5 + childBytes > maxPathBytes)
                throw decodeLimit(
                  NDS_FORMAT,
                  `DS ROM expanded member paths exceed the ${String(maxPathBytes)}-byte allowance.`,
                  {
                    name: NDS_PATH_BYTES_LIMIT,
                    maximum: maxPathBytes,
                    required: 5 + childBytes,
                  },
                  { field: "fnt" },
                );
              pending.push({
                id: childId,
                path: path === "" ? name : `${path}/${name}`,
                depth: childDepth,
              });
            } else
              note(
                "FNT subdirectory",
                `DS FNT subdirectory ${String(childId)} has no usable name; its files are listed by file ID.`,
              );
          } else {
            if (fileId >= NDS_MAX_FILES || fileId >= fat.length)
              note(
                "FNT file",
                `DS FNT file ${JSON.stringify(path === "" ? name : `${path}/${name}`)} is file ${String(fileId)}, which has no FAT entry; it is not listed.`,
              );
            else if (safe && claimed.has(fileId))
              note(
                "FNT file",
                `DS FNT file ${JSON.stringify(path === "" ? name : `${path}/${name}`)} is file ${String(fileId)}, which another entry already claimed; the name is not listed.`,
              );
            else if (safe && fat[fileId] !== undefined) {
              // Safe FNT names are printable ASCII, so string length equals UTF-8 byte length.
              chargePath(5 + childBytes);
              const child = path === "" ? name : `${path}/${name}`;
              fileRegion(fileId, `data/${child}`, "file", null);
            }
            fileId += 1;
          }
          at = end;
        }
      }
    }
  }

  // Every FAT file not reached by name or overlay stays visible by ID.
  for (let id = 0; id < fat.length; id++)
    if (!claimed.has(id) && fat[id] !== undefined) {
      const fatPath = `fat/${String(id).padStart(5, "0")}.bin`;
      chargePath(fatPath.length);
      fileRegion(id, fatPath, "file", null);
    }

  for (const [kind, count] of repeated)
    if (count > NDS_LIMITATION_EXAMPLES)
      limitations.push(
        `DS ${kind}: ${String(count - NDS_LIMITATION_EXAMPLES)} more limitations of this kind are not itemized.`,
      );

  return {
    metadata: {
      ...metadata,
      file_count: fat.length,
      directory_count: directoryCount,
      arm9_overlay_count: overlayCounts.arm9,
      arm7_overlay_count: overlayCounts.arm7,
    },
    regions,
    limitations,
    complete,
  };
};
