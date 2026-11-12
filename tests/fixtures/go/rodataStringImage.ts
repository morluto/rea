export interface GoStringHeaderFixtureSpec {
  readonly section: "rodata" | "data" | "text";
  readonly offsetInSection: number;
  readonly ptr: bigint;
  readonly len: bigint;
}

export interface GoRodataStringFixtureOptions {
  readonly format: "elf" | "pe" | "macho";
  readonly bits?: 32 | 64;
  readonly byteOrder?: "little" | "big";
  readonly rodata: Buffer;
  readonly secondRodata?: Buffer;
  readonly headers: readonly GoStringHeaderFixtureSpec[];
  readonly dataSize?: number;
  readonly sectionless?: boolean;
  readonly corruptElfShstrtab?: boolean;
  readonly elfSplitReversedDataSections?: boolean;
  readonly machoChainedFixups?: boolean;
}

interface LayoutContext {
  readonly bytes: Buffer;
  readonly wide: boolean;
  readonly little: boolean;
  readonly base: bigint;
  readonly textOffset: number;
  readonly textSize: number;
  readonly textAddr: bigint;
  readonly rodataOffset: number;
  readonly rodataSize: number;
  readonly rodataAddr: bigint;
  readonly secondOffset: number;
  readonly secondSize: number;
  readonly secondRodataAddr: bigint;
  readonly dataOffset: number;
  readonly dataSize: number;
  readonly dataAddr: bigint;
  readonly bssSize: number;
  readonly u16: (offset: number, value: number) => void;
  readonly u32: (offset: number, value: number) => void;
  readonly word: (offset: number, value: bigint) => void;
}

/**
 * Authored multi-section ELF, PE and Mach-O images with separate `.text`,
 * `.rodata` / `__rodata` / `.rdata`, and `.data` / `__data` spans.
 */
export const createGoRodataStringFixture = (
  options: GoRodataStringFixtureOptions,
) => {
  const bits = options.bits ?? 64;
  const wide = bits === 64;
  const little = (options.byteOrder ?? "little") === "little";
  const base = 0x100000n;
  const textOffset = 0x1000;
  const textSize = 0x200;
  const rodataOffset = 0x2000;
  const rodataSize = Math.max(16, options.rodata.length);
  const secondOffset = rodataOffset + rodataSize;
  const secondSize = options.secondRodata?.length ?? 0;
  const dataOffset =
    Math.ceil((secondOffset + secondSize + 0x100) / 0x1000) * 0x1000;
  const dataSize = options.dataSize ?? 0x1000;
  const bssSize = 0x200;
  const bytes = Buffer.alloc(dataOffset + dataSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number, v: number) => view.setUint16(at, v, little);
  const u32 = (at: number, v: number) => view.setUint32(at, v, little);
  const word = (at: number, v: bigint) => {
    if (wide) view.setBigUint64(at, v, little);
    else view.setUint32(at, Number(v), little);
  };
  const layout: LayoutContext = {
    bytes,
    wide,
    little,
    base,
    textOffset,
    textSize,
    textAddr: base + BigInt(textOffset),
    rodataOffset,
    rodataSize,
    rodataAddr: base + BigInt(rodataOffset),
    secondOffset,
    secondSize,
    secondRodataAddr: base + BigInt(secondOffset),
    dataOffset,
    dataSize,
    dataAddr: base + BigInt(dataOffset),
    bssSize,
    u16,
    u32,
    word,
  };
  options.rodata.copy(bytes, rodataOffset);
  options.secondRodata?.copy(bytes, secondOffset);
  const width = wide ? 8 : 4;
  for (const header of options.headers) {
    const sectionBase =
      header.section === "text"
        ? textOffset
        : header.section === "rodata"
          ? rodataOffset
          : dataOffset;
    const at = sectionBase + header.offsetInSection;
    word(at, header.ptr);
    word(at + width, header.len);
  }
  if (options.format === "elf") writeElfStringContainer(layout, options);
  else if (options.format === "pe") writePeStringContainer(layout);
  else writeMachoStringContainer(layout, options.machoChainedFixups === true);

  return {
    bytes,
    textAddr: layout.textAddr,
    rodataAddr: layout.rodataAddr,
    rodataOffset,
    secondRodataAddr: layout.secondRodataAddr,
    dataAddr: layout.dataAddr,
    dataOffset,
  };
};

const writeElfStringContainer = (
  ctx: LayoutContext,
  options: GoRodataStringFixtureOptions,
): void => {
  const { bytes, wide, little, u16, u32, word } = ctx;
  bytes.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1]);
  u16(16, 2);
  u16(18, wide ? 62 : 3);
  u32(20, 1);
  const phoff = 128;
  const shoff = options.sectionless === true ? 0 : 512;
  const phentsize = wide ? 56 : 32;
  const shentsize = wide ? 64 : 40;
  const phdrs: readonly [number, number, bigint, number, number][] = [
    [5, ctx.textOffset, ctx.textAddr, ctx.textSize, ctx.textSize],
    [
      4,
      ctx.rodataOffset,
      ctx.rodataAddr,
      ctx.rodataSize + ctx.secondSize,
      ctx.rodataSize + ctx.secondSize,
    ],
    [6, ctx.dataOffset, ctx.dataAddr, ctx.dataSize, ctx.dataSize + ctx.bssSize],
  ];
  phdrs.forEach(([flags, off, vaddr, filesz, memsz], idx) => {
    const p = phoff + idx * phentsize;
    u32(p, 1);
    if (wide) {
      u32(p + 4, flags);
      word(p + 8, BigInt(off));
      word(p + 16, vaddr);
      word(p + 24, vaddr);
      word(p + 32, BigInt(filesz));
      word(p + 40, BigInt(memsz));
      word(p + 48, 0x1000n);
    } else {
      word(p + 4, BigInt(off));
      word(p + 8, vaddr);
      word(p + 12, vaddr);
      word(p + 16, BigInt(filesz));
      word(p + 20, BigInt(memsz));
      u32(p + 24, flags);
      word(p + 28, 0x1000n);
    }
  });
  const shstrOffset = 0xc00;
  const shstr = Buffer.from(
    "\0.shstrtab\0.text\0.rodata\0.rodata.2\0.data\0.bss\0",
  );
  shstr.copy(bytes, shstrOffset);
  const corrupt = options.corruptElfShstrtab === true;
  if (corrupt) u32(shstrOffset, 3);
  const sections: readonly (readonly [
    number,
    number,
    bigint,
    bigint,
    number,
    number,
  ])[] = [
    [1, 3, corrupt ? 0x800n : 0n, 0n, shstrOffset, corrupt ? 24 : shstr.length],
    [11, 1, 6n, ctx.textAddr, ctx.textOffset, ctx.textSize],
    [17, 1, 2n, ctx.rodataAddr, ctx.rodataOffset, ctx.rodataSize],
    ...(ctx.secondSize > 0
      ? ([
          [25, 1, 2n, ctx.secondRodataAddr, ctx.secondOffset, ctx.secondSize],
        ] as const)
      : []),
    ...(options.elfSplitReversedDataSections === true
      ? ([
          [
            35,
            1,
            3n,
            ctx.dataAddr + 0x200n,
            ctx.dataOffset + 0x200,
            ctx.dataSize - 0x200,
          ],
          [35, 1, 3n, ctx.dataAddr + 0x40n, ctx.dataOffset + 0x40, 0x180],
        ] as const)
      : ([[35, 1, 3n, ctx.dataAddr, ctx.dataOffset, ctx.dataSize]] as const)),
    [41, 8, 3n, ctx.dataAddr + BigInt(ctx.dataSize), bytes.length, ctx.bssSize],
  ];
  if (options.sectionless !== true) {
    sections.forEach(([nameOff, type, flags, addr, off, size], idx) => {
      const s = shoff + (idx + 1) * shentsize;
      u32(s, nameOff);
      u32(s + 4, type);
      word(s + 8, flags);
      word(s + (wide ? 16 : 12), addr);
      word(s + (wide ? 24 : 16), BigInt(off));
      word(s + (wide ? 32 : 20), BigInt(size));
    });
  }
  word(wide ? 32 : 28, BigInt(phoff));
  word(wide ? 40 : 32, BigInt(shoff));
  u16(wide ? 52 : 40, wide ? 64 : 52);
  u16(wide ? 54 : 42, phentsize);
  u16(wide ? 56 : 44, 3);
  u16(wide ? 58 : 46, shentsize);
  u16(wide ? 60 : 48, options.sectionless === true ? 0 : sections.length + 1);
  u16(wide ? 62 : 50, options.sectionless === true ? 0 : 1);
};

const writePeStringContainer = (ctx: LayoutContext): void => {
  const { bytes, wide, base, u16, u32, word } = ctx;
  bytes.write("MZ", 0, "ascii");
  u32(60, 128);
  bytes.write("PE\0\0", 128, "ascii");
  u16(132, wide ? 0x8664 : 0x14c);
  const peSections: readonly (readonly [
    string,
    number,
    number,
    number,
    number,
    number,
  ])[] = [
    [
      ".text",
      ctx.textSize,
      ctx.textOffset,
      ctx.textSize,
      ctx.textOffset,
      0x60000020,
    ],
    [
      ".rdata",
      ctx.rodataSize,
      ctx.rodataOffset,
      ctx.rodataSize,
      ctx.rodataOffset,
      0x40000040,
    ],
    ...(ctx.secondSize > 0
      ? ([
          [
            ".rdata2",
            ctx.secondSize,
            ctx.secondOffset,
            ctx.secondSize,
            ctx.secondOffset,
            0x40000040,
          ],
        ] as const)
      : []),
    [
      ".data",
      ctx.dataSize + ctx.bssSize,
      ctx.dataOffset,
      ctx.dataSize,
      ctx.dataOffset,
      0xc0000040,
    ],
  ];
  u16(134, peSections.length);
  const optSize = wide ? 112 : 96;
  u16(148, optSize);
  u16(152, wide ? 0x20b : 0x10b);
  word(152 + (wide ? 24 : 28), base);
  u32(152 + 32, 0x1000);
  u32(152 + 36, 0x200);
  u32(152 + 56, bytes.length + 0x1000);
  u32(152 + 60, 0x400);
  peSections.forEach(([name, vsize, rva, rawSize, rawOff, chars], index) => {
    const s = 152 + optSize + index * 40;
    bytes.write(name, s, "ascii");
    u32(s + 8, vsize);
    u32(s + 12, rva);
    u32(s + 16, rawSize);
    u32(s + 20, rawOff);
    u32(s + 36, chars);
  });
};

const writeMachoStringContainer = (
  ctx: LayoutContext,
  chainedFixups: boolean,
): void => {
  const { bytes, wide, base, u32, word } = ctx;
  u32(0, wide ? 0xfeedfacf : 0xfeedface);
  u32(4, wide ? 0x0100000c : 7);
  u32(8, 0);
  u32(12, 2);
  const segHdr = wide ? 72 : 56;
  const secHdr = wide ? 80 : 68;
  const textSecs: readonly (readonly [
    string,
    bigint,
    number,
    number,
    number,
  ])[] = [
    ["__text", ctx.textAddr, ctx.textSize, ctx.textOffset, 0x80000400],
    ["__rodata", ctx.rodataAddr, ctx.rodataSize, ctx.rodataOffset, 0],
    ...(ctx.secondSize > 0
      ? ([
          [
            "__const",
            ctx.secondRodataAddr,
            ctx.secondSize,
            ctx.secondOffset,
            0,
          ],
        ] as const)
      : []),
  ];
  const dataSecs: readonly (readonly [
    string,
    bigint,
    number,
    number,
    number,
  ])[] = [["__data", ctx.dataAddr, ctx.dataSize, ctx.dataOffset, 0]];
  const cmd0Size = segHdr + textSecs.length * secHdr;
  const cmd1Size = segHdr + dataSecs.length * secHdr;
  const fixupSize = chainedFixups ? 16 : 0;
  u32(16, 2 + (fixupSize > 0 ? 1 : 0));
  u32(20, cmd0Size + cmd1Size + fixupSize);
  let cursor = wide ? 32 : 28;
  for (const [segName, vmaddr, vmsize, fileoff, filesize, prot, secs] of [
    ["__TEXT", base, BigInt(ctx.dataOffset), 0, ctx.dataOffset, 5, textSecs],
    [
      "__DATA",
      ctx.dataAddr,
      BigInt(ctx.dataSize + ctx.bssSize),
      ctx.dataOffset,
      ctx.dataSize,
      3,
      dataSecs,
    ],
  ] as const) {
    const size = segHdr + secs.length * secHdr;
    u32(cursor, wide ? 0x19 : 1);
    u32(cursor + 4, size);
    bytes.write(segName, cursor + 8, "ascii");
    word(cursor + 24, vmaddr);
    word(cursor + (wide ? 32 : 28), vmsize);
    word(cursor + (wide ? 40 : 32), BigInt(fileoff));
    word(cursor + (wide ? 48 : 36), BigInt(filesize));
    u32(cursor + (wide ? 56 : 40), prot);
    u32(cursor + (wide ? 60 : 44), prot);
    u32(cursor + (wide ? 64 : 48), secs.length);
    secs.forEach(([secName, addr, secSize, off, flags], idx) => {
      const s = cursor + segHdr + idx * secHdr;
      bytes.write(secName, s, "ascii");
      bytes.write(segName, s + 16, "ascii");
      word(s + 32, addr);
      word(s + (wide ? 40 : 36), BigInt(secSize));
      u32(s + (wide ? 48 : 40), off);
      u32(s + (wide ? 64 : 56), flags);
    });
    cursor += size;
  }
  if (fixupSize > 0) {
    u32(cursor, 0x80000034);
    u32(cursor + 4, fixupSize);
  }
};
