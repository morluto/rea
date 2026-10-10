import {
  GoBinaryFormatFailure,
  GoBinaryReader,
  mappedFileOffset,
  type GoBinaryContainer,
  type GoFileMapping,
  type GoZeroFillMapping,
} from "./GoBinaryContainer.js";

/** Read thin Mach-O images, retaining the slice's exact file-backed mappings. */
export const readGoMachoImage = (bytes: Buffer): GoBinaryContainer => {
  const magic = bytes.readUInt32BE(0);
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const bits = magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : 32;
  const reader = new GoBinaryReader(bytes, little);
  const headerSize = bits === 64 ? 32 : 28;
  reader.range(0, headerSize, "Mach-O header");
  const count = reader.u32(16);
  const commandBytes = reader.u32(20);
  const commandStart = reader.table(
    BigInt(headerSize),
    commandBytes,
    1,
    "Mach-O load commands",
  );
  if (count > Math.floor(commandBytes / 8))
    throw new GoBinaryFormatFailure(
      "malformed",
      "Mach-O command count exceeds its load-command range",
    );
  const mappings: GoFileMapping[] = [];
  const zeroFills: GoZeroFillMapping[] = [];
  const named: GoFileMapping[] = [];
  let fallback: GoFileMapping | null = null;
  let offset = commandStart;
  const end = commandStart + commandBytes;
  for (let index = 0; index < count; index++) {
    const command = reader.u32(offset);
    const size = reader.u32(offset + 4);
    if (size < 8 || size % 4 !== 0 || size > end - offset)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Mach-O load command size is invalid or truncated",
      );
    if (command === 1 || command === 0x19) {
      const wide = command === 0x19;
      if (wide !== (bits === 64))
        throw new GoBinaryFormatFailure(
          "malformed",
          "Mach-O segment command does not match the header width",
        );
      const segmentHeader = wide ? 72 : 56;
      const sectionWidth = wide ? 80 : 68;
      if (size < segmentHeader)
        throw new GoBinaryFormatFailure(
          "malformed",
          "Mach-O segment header is truncated",
        );
      const address = reader.word(offset + 24, bits);
      const memorySize = reader.word(offset + (wide ? 32 : 28), bits);
      const fileOffset = reader.word(offset + (wide ? 40 : 32), bits);
      const fileSize = reader.word(offset + (wide ? 48 : 36), bits);
      const maxProtection = reader.u32(offset + (wide ? 56 : 40));
      const protection = reader.u32(offset + (wide ? 60 : 44));
      const sectionCount = reader.u32(offset + (wide ? 64 : 48));
      if (fileSize > memorySize || address + memorySize > 1n << BigInt(bits))
        throw new GoBinaryFormatFailure(
          "malformed",
          "Mach-O segment addresses or sizes are invalid",
        );
      if (sectionCount > Math.floor((size - segmentHeader) / sectionWidth))
        throw new GoBinaryFormatFailure(
          "malformed",
          "Mach-O section table exceeds its segment command",
        );
      const mapping = {
        ...(fileSize === 0n
          ? { offset: 0, size: 0 }
          : reader.fileRange(fileOffset, fileSize, "Mach-O segment")),
        address,
      };
      const name = fixedName(
        reader.range(offset + 8, 16, "Mach-O segment name"),
      );
      if (mapping.size !== 0 && name !== "__PAGEZERO") mappings.push(mapping);
      if (memorySize > fileSize && name !== "__PAGEZERO")
        zeroFills.push({
          address: address + fileSize,
          size: memorySize - fileSize,
        });
      if (
        fallback === null &&
        address !== 0n &&
        mapping.size !== 0 &&
        protection === 3 &&
        maxProtection === 3
      )
        fallback = mapping;
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
        const section = offset + segmentHeader + sectionIndex * sectionWidth;
        if (
          fixedName(reader.range(section, 16, "Mach-O section name")) !==
          "__go_buildinfo"
        )
          continue;
        const sectionFlags = reader.u32(section + (wide ? 64 : 56));
        if ([1, 0xc, 0x12].includes(sectionFlags & 0xff))
          throw new GoBinaryFormatFailure(
            "malformed",
            "Mach-O build-info section is zero-fill data",
          );
        const sectionAddress = reader.word(section + 32, bits);
        const sectionSize = reader.word(section + (wide ? 40 : 36), bits);
        const sectionOffset = BigInt(reader.u32(section + (wide ? 48 : 40)));
        const info = {
          ...reader.fileRange(
            sectionOffset,
            sectionSize,
            "Mach-O build-info section",
          ),
          address: sectionAddress,
        };
        if (
          mappedFileOffset([mapping], sectionAddress, info.size) !== info.offset
        )
          throw new GoBinaryFormatFailure(
            "malformed",
            "Mach-O build-info section disagrees with its segment",
          );
        named.push(info);
      }
    }
    offset += size;
  }
  if (offset !== end)
    throw new GoBinaryFormatFailure(
      "malformed",
      "Mach-O load-command byte count does not match its commands",
    );
  if (named.length > 1)
    throw new GoBinaryFormatFailure(
      "malformed",
      "Mach-O has ambiguous build-info sections",
    );
  const cpu = reader.u32(4);
  const names = new Map([
    [7, "386"],
    [0x01000007, "amd64"],
    [12, "arm"],
    [0x0100000c, "arm64"],
    [18, "ppc"],
    [0x01000012, "ppc64"],
  ]);
  return {
    format: "macho",
    architecture: names.get(cpu) ?? `macho-cpu-${cpu}`,
    bits,
    byte_order: little ? "little" : "big",
    mappings,
    zero_fills: zeroFills,
    search: named[0] ?? fallback,
  };
};

const fixedName = (bytes: Buffer): string => {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString("latin1");
};
