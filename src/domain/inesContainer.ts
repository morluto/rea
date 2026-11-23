import { z } from "zod";
import { BinaryReader } from "./binaryContainer.js";
import type { ParseFailure } from "./parseFailure.js";
import { err, ok, type Result } from "./result.js";

type FailureSite = { readonly offset?: number; readonly field?: string };

/** iNES-family failures in the shared parser algebra, with where they were found. */
const malformed = (detail: string, at: FailureSite = {}): ParseFailure => ({
  kind: "malformed",
  format: "ines",
  detail,
  ...at,
});
const truncated = (detail: string, at: FailureSite = {}): ParseFailure => ({
  kind: "truncated",
  format: "ines",
  detail,
  ...at,
});
const unsupported = (detail: string, at: FailureSite = {}): ParseFailure => ({
  kind: "unsupported",
  format: "ines",
  detail,
  undecodedContent: true,
  ...at,
});

/** Byte signatures select a container family, never an executable architecture. */
export const nesContainerFormat = (
  prefix: Buffer,
): "ines" | "nes-2.0" | "unif" | undefined => {
  if (prefix.length < 4) return undefined;
  if (
    prefix[0] === 0x55 &&
    prefix[1] === 0x4e &&
    prefix[2] === 0x49 &&
    prefix[3] === 0x46
  )
    return "unif";
  if (
    prefix[0] !== 0x4e ||
    prefix[1] !== 0x45 ||
    prefix[2] !== 0x53 ||
    prefix[3] !== 0x1a
  )
    return undefined;
  return prefix.length >= 8 && (prefix[7]! & 0x0c) === 0x08
    ? "nes-2.0"
    : "ines";
};

const headerHexSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const byteSchema = z.number().int().min(0).max(255);
const nibbleSchema = z.number().int().min(0).max(15);
const mirroringSchema = z.enum(["horizontal", "vertical", "four-screen"]);
const NES_2_CONSOLE_TYPES = [
  "nes-famicom",
  "vs-system",
  "playchoice-10",
  "extended",
] as const;
const NES_2_TIMINGS = ["ntsc", "pal", "multiple-region", "dendy"] as const;
// Byte 13 is defined only for Vs. System and extended console types.
const NES_2_BYTE_13_RESERVED = [0xff, 0, 0xff, 0xf0] as const;
type TwoBits = 0 | 1 | 2 | 3;
// The mask proves the index; the assertion only states it to the checker.
const twoBits = (value: number): TwoBits => (value & 3) as TwoBits;
// A nonzero shift count declares 64 << count bytes; zero declares none.
const declaredRamBytesSchema = z
  .number()
  .int()
  .min(0)
  .max(64 << 15);

const classicInesHeaderSchema = z.strictObject({
  format: z.literal("ines"),
  header_hex: headerHexSchema,
  prg_rom_units_16k: z.number().int().min(1).max(255),
  chr_rom_units_8k: z.number().int().min(0).max(255),
  mapper: byteSchema,
  flags_6: byteSchema,
  flags_7: byteSchema,
  trainer_present: z.boolean(),
  battery_flag: z.boolean(),
  mirroring: mirroringSchema,
});

/**
 * NES 2.0 sizes, memory, timing, console and device codes are header
 * declarations. Unit counts are omitted when the exponent-multiplier form
 * declares a byte size instead.
 */
const nes2HeaderSchema = z.strictObject({
  format: z.literal("nes-2.0"),
  header_hex: headerHexSchema,
  prg_rom_units_16k: z.number().int().min(1).max(0xeff).exactOptional(),
  chr_rom_units_8k: z.number().int().min(0).max(0xeff).exactOptional(),
  prg_rom_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  chr_rom_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mapper: z.number().int().min(0).max(0xfff),
  submapper: nibbleSchema,
  flags_6: byteSchema,
  flags_7: byteSchema,
  trainer_present: z.boolean(),
  battery_flag: z.boolean(),
  nametable_layout_flags: z.strictObject({
    arrangement_bit: z.boolean(),
    alternative_layout_bit: z.boolean(),
  }),
  console_type: z.enum(NES_2_CONSOLE_TYPES),
  vs_ppu_type: nibbleSchema.exactOptional(),
  vs_hardware_type: nibbleSchema.exactOptional(),
  extended_console_type: nibbleSchema.exactOptional(),
  cpu_ppu_timing: z.enum(NES_2_TIMINGS),
  prg_ram_bytes: declaredRamBytesSchema,
  prg_nvram_bytes: declaredRamBytesSchema,
  chr_ram_bytes: declaredRamBytesSchema,
  chr_nvram_bytes: declaredRamBytesSchema,
  misc_rom_count: z.number().int().min(0).max(3),
  default_expansion_device: z.number().int().min(0).max(0x7f),
});

/** Verified concatenation is a byte identity claim, not an emulator claim. */
export const inesInventorySchema = z.strictObject({
  header: z.discriminatedUnion("format", [
    classicInesHeaderSchema,
    nes2HeaderSchema,
  ]),
  reconstruction: z.strictObject({
    region_order: z.array(z.string().min(1)).min(2),
    bytes: z.number().int().min(16).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    verified: z.literal(true),
  }),
});

export type InesInventory = z.infer<typeof inesInventorySchema>;
type InesHeader = InesInventory["header"];

export interface InesRegion {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
}

export interface InesLayout {
  readonly header: InesHeader;
  readonly regions: readonly InesRegion[];
}

/** A declared ROM area; unit regions exist only when the header counts units. */
interface RomArea {
  /** Integer-valued; exponent-multiplier declarations can exceed safe integers. */
  readonly bytes: number;
  readonly unitBytes?: number;
}

/** Header facts plus the ROM areas they declare in file order. */
interface HeaderDeclaration {
  readonly header: InesHeader;
  readonly prg: RomArea;
  readonly chr: RomArea;
}

const classicMirroring = (flags6: number): z.infer<typeof mirroringSchema> =>
  (flags6 & 8) !== 0
    ? "four-screen"
    : (flags6 & 1) !== 0
      ? "vertical"
      : "horizontal";

/**
 * Classic iNES counts 16 KiB PRG and 8 KiB CHR file units. Those units do not
 * establish the mapper's runtime windows. Preserve all other bytes verbatim.
 */
const classicDeclaration = (
  reader: BinaryReader,
): Result<HeaderDeclaration, ParseFailure> => {
  const prgUnits = reader.u8(4);
  const chrUnits = reader.u8(5);
  const flags6 = reader.u8(6);
  const flags7 = reader.u8(7);
  if ((flags7 & 0x0c) !== 0)
    return err(
      unsupported("unsupported iNES header variant", {
        offset: 7,
        field: "flags 7",
      }),
    );
  // Dirty legacy headers make the upper mapper bits ambiguous. Do not repair
  // them or claim a mapper that the observed header cannot establish.
  if (reader.range(12, 4, "reserved header bytes").some((byte) => byte !== 0))
    return err(
      malformed(
        "ambiguous iNES mapper: reserved header bytes 12..15 are nonzero",
        { offset: 12, field: "bytes 12..15" },
      ),
    );
  if (prgUnits === 0)
    return err(
      malformed("iNES requires at least one PRG-ROM unit", {
        offset: 4,
        field: "PRG-ROM size",
      }),
    );
  return ok({
    prg: { bytes: prgUnits * 16_384, unitBytes: 16_384 },
    chr: { bytes: chrUnits * 8_192, unitBytes: 8_192 },
    header: {
      format: "ines",
      header_hex: reader.range(0, 16, "header").toString("hex"),
      prg_rom_units_16k: prgUnits,
      chr_rom_units_8k: chrUnits,
      mapper: (flags6 >>> 4) | (flags7 & 0xf0),
      flags_6: flags6,
      flags_7: flags7,
      trainer_present: (flags6 & 4) !== 0,
      battery_flag: (flags6 & 2) !== 0,
      mirroring: classicMirroring(flags6),
    },
  });
};

/** NES 2.0 MSB nibble 0xF selects 2^E * (MM * 2 + 1) bytes from the LSB. */
const nes2RomArea = (lsb: number, msb: number, unitBytes: number): RomArea =>
  msb === 0x0f
    ? { bytes: 2 ** (lsb >>> 2) * ((lsb & 3) * 2 + 1) }
    : { bytes: ((msb << 8) | lsb) * unitBytes, unitBytes };

const declaredRamBytes = (shift: number): number =>
  shift === 0 ? 0 : 64 << shift;

/**
 * NES 2.0 extends the classic file layout with 12-bit sizes, exponent sizes
 * and miscellaneous ROM bytes after CHR-ROM. Unused bits must be zero; nonzero
 * bits are refused rather than interpreted.
 */
const nes2Declaration = (
  reader: BinaryReader,
): Result<HeaderDeclaration, ParseFailure> => {
  const byte = (index: number) => reader.u8(index);
  const flags6 = byte(6);
  const flags7 = byte(7);
  const consoleType = twoBits(flags7);
  for (const [index, reserved] of [
    [12, 0xfc],
    [13, NES_2_BYTE_13_RESERVED[consoleType]],
    [14, 0xfc],
    [15, 0x80],
  ] as const)
    if ((byte(index) & reserved) !== 0)
      return err(
        malformed(`reserved NES 2.0 header bits are nonzero in byte ${index}`, {
          offset: index,
          field: `byte ${index}`,
        }),
      );
  const prg = nes2RomArea(byte(4), byte(9) & 0x0f, 16_384);
  const chr = nes2RomArea(byte(5), byte(9) >>> 4, 8_192);
  if (prg.bytes === 0)
    return err(
      malformed("NES 2.0 requires at least one PRG-ROM unit", {
        offset: 4,
        field: "PRG-ROM size",
      }),
    );
  return ok({
    prg,
    chr,
    header: {
      format: "nes-2.0",
      header_hex: reader.range(0, 16, "header").toString("hex"),
      ...(prg.unitBytes === undefined
        ? {}
        : { prg_rom_units_16k: prg.bytes / prg.unitBytes }),
      ...(chr.unitBytes === undefined
        ? {}
        : { chr_rom_units_8k: chr.bytes / chr.unitBytes }),
      prg_rom_bytes: prg.bytes,
      chr_rom_bytes: chr.bytes,
      mapper: ((byte(8) & 0x0f) << 8) | (flags7 & 0xf0) | (flags6 >>> 4),
      submapper: byte(8) >>> 4,
      flags_6: flags6,
      flags_7: flags7,
      trainer_present: (flags6 & 4) !== 0,
      battery_flag: (flags6 & 2) !== 0,
      // The mapper can override the hard-wired arrangement or give these bits a different meaning.
      nametable_layout_flags: {
        arrangement_bit: (flags6 & 1) !== 0,
        alternative_layout_bit: (flags6 & 8) !== 0,
      },
      console_type: NES_2_CONSOLE_TYPES[consoleType],
      ...(consoleType === 1
        ? { vs_ppu_type: byte(13) & 0x0f, vs_hardware_type: byte(13) >>> 4 }
        : {}),
      ...(consoleType === 3 ? { extended_console_type: byte(13) & 0x0f } : {}),
      cpu_ppu_timing: NES_2_TIMINGS[twoBits(byte(12))],
      prg_ram_bytes: declaredRamBytes(byte(10) & 0x0f),
      prg_nvram_bytes: declaredRamBytes(byte(10) >>> 4),
      chr_ram_bytes: declaredRamBytes(byte(11) & 0x0f),
      chr_nvram_bytes: declaredRamBytes(byte(11) >>> 4),
      misc_rom_count: byte(14) & 3,
      default_expansion_device: byte(15) & 0x7f,
    },
  });
};

/**
 * Own iNES-family header interpretation for every consumer. PRG/CHR units and
 * byte sizes describe file storage, not mapper windows; RAM sizes create no
 * regions.
 */
export const parseInesLayout = (
  prefix: Buffer,
  fileSize: number,
): Result<InesLayout, ParseFailure> => {
  const format = nesContainerFormat(prefix);
  if (format === undefined)
    return err(
      malformed("missing iNES byte signature", {
        offset: 0,
        field: "signature",
      }),
    );
  if (format === "unif")
    return err(
      unsupported("unif containers are not supported by the iNES lane", {
        offset: 0,
        field: "signature",
      }),
    );
  const reader = new BinaryReader(prefix, true, "ines");
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    return err(
      malformed(
        "invalid iNES file extent: expected a nonnegative safe integer",
        { field: "file extent" },
      ),
    );
  if (fileSize < 16 || prefix.length < 16)
    return err(
      truncated("truncated iNES header: expected 16 bytes", {
        offset: 0,
        field: "header",
      }),
    );
  const declared =
    format === "ines" ? classicDeclaration(reader) : nes2Declaration(reader);
  if (!declared.ok) return declared;
  const { header, prg, chr } = declared.value;
  const label = header.format === "ines" ? "iNES" : "NES 2.0";
  const trainer = header.trainer_present;
  const miscRomCount = header.format === "ines" ? 0 : header.misc_rom_count;
  // Exact arithmetic reports oversized exponent declarations without rounding.
  const declaredEnd =
    BigInt(16 + (trainer ? 512 : 0)) + BigInt(prg.bytes) + BigInt(chr.bytes);
  if (declaredEnd > BigInt(fileSize))
    return err(
      truncated(
        `truncated ${label} payload: header declares ${declaredEnd} bytes; file has ${fileSize}`,
        { field: "payload" },
      ),
    );
  const regions: InesRegion[] = [{ path: "header.bin", offset: 0, length: 16 }];
  let offset = 16;
  if (trainer) {
    regions.push({ path: "trainer.bin", offset, length: 512 });
    offset += 512;
  }
  for (const [kind, area] of [
    ["prg", prg],
    ["chr", chr],
  ] as const) {
    if (area.unitBytes === undefined) {
      regions.push({ path: `${kind}.bin`, offset, length: area.bytes });
      offset += area.bytes;
      continue;
    }
    for (let index = 0; index < area.bytes / area.unitBytes; index += 1) {
      regions.push({
        path: `${kind}/${String(index).padStart(3, "0")}.bin`,
        offset,
        length: area.unitBytes,
      });
      offset += area.unitBytes;
    }
  }
  if (miscRomCount > 0) {
    // Miscellaneous ROM boundaries are mapper-specific; keep the area whole.
    if (offset === fileSize)
      return err(
        truncated(
          `${label} declares ${miscRomCount} miscellaneous ROM${miscRomCount === 1 ? "" : "s"} but no bytes follow CHR-ROM`,
          { offset, field: "miscellaneous ROM" },
        ),
      );
    regions.push({
      path: "misc-rom.bin",
      offset,
      length: fileSize - offset,
    });
  } else if (offset < fileSize)
    regions.push({ path: "trailing.bin", offset, length: fileSize - offset });
  return ok({ header, regions });
};
