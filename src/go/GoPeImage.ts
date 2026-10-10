import { mzWindowsHeaderOffset, parseDosMzHeader } from "../domain/dosMz.js";
import {
  GoBinaryFormatFailure,
  GoBinaryReader,
  type GoBinaryContainer,
  type GoFileMapping,
  type GoZeroFillMapping,
} from "./GoBinaryContainer.js";

const peHeaderOffset = (reader: GoBinaryReader): number => {
  const pe = mzWindowsHeaderOffset(reader.bytes);
  if (pe === null) {
    const dos = parseDosMzHeader(reader.bytes);
    if (!dos.ok) throw new GoBinaryFormatFailure("malformed", dos.error);
    throw new GoBinaryFormatFailure(
      "unsupported",
      "DOS MZ images are outside the supported ELF, PE and thin Mach-O formats",
    );
  }
  if (pe < 64)
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE signature overlaps the DOS header",
    );
  const signature = reader
    .range(pe, 2, "Windows new-header signature")
    .toString("latin1");
  if (["NE", "LE", "LX"].includes(signature))
    throw new GoBinaryFormatFailure(
      "unsupported",
      `${signature} images are outside the supported ELF, PE and thin Mach-O formats`,
    );
  return pe;
};

const optionalHeaderMagic = (
  reader: GoBinaryReader,
  offset: number,
  size: number,
): number => {
  reader.range(offset, size, "PE optional header");
  if (size < 2)
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE optional header is missing its complete magic field",
    );
  return reader.u16(offset);
};

/** Read PE32/PE32+ native image mappings and the linker data section. */
export const readGoPeImage = (bytes: Buffer): GoBinaryContainer => {
  const reader = new GoBinaryReader(bytes, true);
  const pe = peHeaderOffset(reader);
  if (
    !reader
      .range(pe, 24, "PE signature and COFF header")
      .subarray(0, 4)
      .equals(Buffer.from("PE\0\0"))
  )
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE signature is invalid or overlaps the DOS header",
    );
  const optional = pe + 24;
  const optionalSize = reader.u16(pe + 20);
  const magic = optionalHeaderMagic(reader, optional, optionalSize);
  const bits = magic === 0x10b ? 32 : magic === 0x20b ? 64 : null;
  if (bits === null)
    throw new GoBinaryFormatFailure(
      "unsupported",
      "Only PE32 and PE32+ image optional headers are supported",
    );
  if (optionalSize < (bits === 64 ? 112 : 96))
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE optional header is truncated",
    );
  const directoriesOffset = bits === 64 ? 112 : 96;
  const directories = reader.u32(optional + directoriesOffset - 4);
  if (directories * 8 > optionalSize - directoriesOffset)
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE data directories extend beyond the optional header",
    );
  const imageBase = reader.word(optional + (bits === 64 ? 24 : 28), bits);
  const count = reader.u16(pe + 6);
  const start = reader.table(
    BigInt(optional + optionalSize),
    count,
    40,
    "PE sections",
  );
  const mappings: GoFileMapping[] = [];
  const zeroFills: GoZeroFillMapping[] = [];
  let search: GoFileMapping | null = null;
  for (let index = 0; index < count; index++) {
    const entry = start + index * 40;
    const virtualSize = reader.u32(entry + 8);
    const virtualAddress = reader.u32(entry + 12);
    const size = reader.u32(entry + 16);
    const offset = reader.u32(entry + 20);
    const characteristics = reader.u32(entry + 36);
    const address = imageBase + BigInt(virtualAddress);
    if (address + BigInt(Math.max(size, virtualSize)) > 1n << BigInt(bits))
      throw new GoBinaryFormatFailure(
        "malformed",
        "PE section virtual address overflows its address width",
      );
    const mapping = {
      ...(size === 0
        ? { offset: 0, size: 0 }
        : reader.fileRange(BigInt(offset), BigInt(size), "PE section")),
      address,
    };
    if (size !== 0) mappings.push(mapping);
    if (virtualSize > size)
      zeroFills.push({
        address: address + BigInt(size),
        size: BigInt(virtualSize - size),
      });
    // Match debug/buildinfo's first initialized, readable, writable data section.
    if (
      search === null &&
      virtualAddress !== 0 &&
      size !== 0 &&
      (characteristics & ~0x00600000) >>> 0 === 0xc0000040
    ) {
      search = { ...mapping, size: Math.min(size, virtualSize) };
    }
  }
  const machine = reader.u16(pe + 4);
  const names = new Map([
    [0x014c, "386"],
    [0x8664, "amd64"],
    [0x01c0, "arm"],
    [0x01c2, "arm"],
    [0x01c4, "arm"],
    [0xaa64, "arm64"],
  ]);
  return {
    format: "pe",
    architecture: names.get(machine) ?? `pe-machine-${machine}`,
    bits,
    byte_order: "little",
    mappings,
    zero_fills: zeroFills,
    search,
  };
};
