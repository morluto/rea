import {
  GoBinaryFormatFailure,
  GoBinaryReader,
  mappedFileOffset,
  type GoBinaryContainer,
  type GoFileMapping,
  type GoZeroFillMapping,
} from "./GoBinaryContainer.js";

/** Read ELF build-info sections and file-backed program mappings. */
export const readGoElfImage = (bytes: Buffer): GoBinaryContainer => {
  if (bytes.length < 16)
    throw new GoBinaryFormatFailure(
      "malformed",
      "ELF identification is truncated",
    );
  const bits = bytes[4] === 1 ? 32 : bytes[4] === 2 ? 64 : null;
  if (bits === null || ![1, 2].includes(bytes[5] ?? 0) || bytes[6] !== 1)
    throw new GoBinaryFormatFailure(
      "malformed",
      "ELF class, byte order, or version is invalid",
    );
  const reader = new GoBinaryReader(bytes, bytes[5] === 1);
  const wide = bits === 64;
  const minimum = wide ? 64 : 52;
  reader.range(0, minimum, "ELF header");
  if (reader.u32(20) !== 1 || reader.u16(wide ? 52 : 40) < minimum)
    throw new GoBinaryFormatFailure(
      "malformed",
      "ELF header version or size is invalid",
    );
  const headerSize = reader.u16(wide ? 52 : 40);
  reader.range(0, headerSize, "ELF declared header");
  const phOffset = reader.word(wide ? 32 : 28, bits);
  const shOffset = reader.word(wide ? 40 : 32, bits);
  const phWidth = reader.u16(wide ? 54 : 42);
  const shWidth = reader.u16(wide ? 58 : 46);
  let phCount = reader.u16(wide ? 56 : 44);
  let shCount = reader.u16(wide ? 60 : 48);
  let namesIndex = reader.u16(wide ? 62 : 50);
  if (
    (phCount !== 0 && phOffset < BigInt(headerSize)) ||
    (shOffset !== 0n && shOffset < BigInt(headerSize))
  )
    throw new GoBinaryFormatFailure(
      "malformed",
      "ELF header table overlaps the native header",
    );
  if (
    shOffset !== 0n &&
    (shCount === 0 || phCount === 0xffff || namesIndex === 0xffff)
  ) {
    if (shWidth < (wide ? 64 : 40))
      throw new GoBinaryFormatFailure(
        "malformed",
        "ELF extended section header width is invalid",
      );
    const first = reader.fileRange(
      shOffset,
      BigInt(shWidth),
      "ELF section zero",
    ).offset;
    if (reader.u32(first + 4) !== 0)
      throw new GoBinaryFormatFailure(
        "malformed",
        "ELF initial section for extended numbering must have SHT_NULL type",
      );
    if (shCount === 0) {
      const count = reader.word(first + (wide ? 32 : 20), bits);
      if (count < 0xff00n || count > BigInt(Number.MAX_SAFE_INTEGER))
        throw new GoBinaryFormatFailure(
          "malformed",
          "ELF extended section count is invalid",
        );
      shCount = Number(count);
    }
    if (phCount === 0xffff) {
      phCount = reader.u32(first + (wide ? 44 : 28));
      if (phCount < 0xffff)
        throw new GoBinaryFormatFailure(
          "malformed",
          "ELF extended program count is below its reserved range",
        );
    }
    if (namesIndex === 0xffff) {
      namesIndex = reader.u32(first + (wide ? 40 : 24));
      if (namesIndex < 0xff00)
        throw new GoBinaryFormatFailure(
          "malformed",
          "ELF extended section name index is below its reserved range",
        );
    }
  } else if (
    shOffset === 0n &&
    (shCount !== 0 || namesIndex !== 0 || phCount === 0xffff)
  ) {
    throw new GoBinaryFormatFailure(
      "malformed",
      "ELF section table is missing",
    );
  }
  if (phCount !== 0 && phWidth < (wide ? 56 : 32))
    throw new GoBinaryFormatFailure(
      "malformed",
      "ELF program header width is invalid",
    );
  const phStart = reader.table(
    phOffset,
    phCount,
    phWidth,
    "ELF program headers",
  );
  const mappings: GoFileMapping[] = [];
  const zeroFills: GoZeroFillMapping[] = [];
  let fallback: GoFileMapping | null = null;
  for (let index = 0; index < phCount; index++) {
    const offset = phStart + index * phWidth;
    if (reader.u32(offset) !== 1) continue;
    const flags = reader.u32(offset + (wide ? 4 : 24));
    const fileOffset = reader.word(offset + (wide ? 8 : 4), bits);
    const address = reader.word(offset + (wide ? 16 : 8), bits);
    const size = reader.word(offset + (wide ? 32 : 16), bits);
    const memorySize = reader.word(offset + (wide ? 40 : 20), bits);
    if (size > memorySize || address + memorySize > 1n << BigInt(bits))
      throw new GoBinaryFormatFailure(
        "malformed",
        "ELF load segment sizes or addresses are invalid",
      );
    const mapping = {
      ...(size === 0n
        ? { offset: 0, size: 0 }
        : reader.fileRange(fileOffset, size, "ELF load segment")),
      address,
    };
    if (mapping.size !== 0) mappings.push(mapping);
    if (memorySize > size)
      zeroFills.push({ address: address + size, size: memorySize - size });
    if (fallback === null && (flags & 3) === 2) fallback = mapping;
  }
  let search: GoFileMapping | null = null;
  if (shCount !== 0) {
    if (shWidth < (wide ? 64 : 40) || namesIndex >= shCount)
      throw new GoBinaryFormatFailure(
        "malformed",
        "ELF section width or name-table index is invalid",
      );
    const shStart = reader.table(
      shOffset,
      shCount,
      shWidth,
      "ELF section headers",
    );
    if (namesIndex !== 0) {
      const namesHeader = shStart + namesIndex * shWidth;
      if (reader.u32(namesHeader + 4) !== 3)
        throw new GoBinaryFormatFailure(
          "malformed",
          "ELF section name table is not a string table",
        );
      const names = reader.fileRange(
        reader.word(namesHeader + (wide ? 24 : 16), bits),
        reader.word(namesHeader + (wide ? 32 : 20), bits),
        "ELF section names",
      );
      for (let index = 0; index < shCount; index++) {
        const offset = shStart + index * shWidth;
        const nameOffset = reader.u32(offset);
        if (nameOffset >= names.size)
          throw new GoBinaryFormatFailure(
            "malformed",
            "ELF section name offset is outside its string table",
          );
        // Comparing the complete fixed name avoids quadratic scans through malicious string tables.
        const expectedName = Buffer.from(".go.buildinfo\0");
        if (
          expectedName.length > names.size - nameOffset ||
          !bytes
            .subarray(
              names.offset + nameOffset,
              names.offset + nameOffset + expectedName.length,
            )
            .equals(expectedName)
        )
          continue;
        if (search !== null)
          throw new GoBinaryFormatFailure(
            "malformed",
            "ELF contains ambiguous build-info sections",
          );
        if (reader.u32(offset + 4) !== 1)
          throw new GoBinaryFormatFailure(
            "malformed",
            "ELF build-info section is not file-backed data",
          );
        if ((reader.word(offset + 8, bits) & 0x800n) !== 0n)
          throw new GoBinaryFormatFailure(
            "unsupported",
            "Compressed ELF build-info sections are unsupported",
          );
        const address = reader.word(offset + (wide ? 16 : 12), bits);
        search = {
          ...reader.fileRange(
            reader.word(offset + (wide ? 24 : 16), bits),
            reader.word(offset + (wide ? 32 : 20), bits),
            "ELF build-info section",
          ),
          address,
        };
        if (
          mappedFileOffset(mappings, address, search.size, zeroFills) !==
          search.offset
        )
          throw new GoBinaryFormatFailure(
            "malformed",
            "ELF build-info section disagrees with its load mapping",
          );
      }
    }
  }
  const machine = reader.u16(18);
  return {
    format: "elf",
    architecture: elfArchitecture(machine),
    bits,
    byte_order: reader.little ? "little" : "big",
    mappings,
    zero_fills: zeroFills,
    search: search ?? fallback,
  };
};

const elfArchitecture = (machine: number): string => {
  const names = new Map([
    [3, "386"],
    [8, "mips"],
    [20, "ppc"],
    [21, "ppc64"],
    [22, "s390"],
    [40, "arm"],
    [62, "amd64"],
    [183, "arm64"],
    [243, "riscv"],
    [258, "loongarch"],
  ]);
  return names.get(machine) ?? `elf-machine-${machine}`;
};
