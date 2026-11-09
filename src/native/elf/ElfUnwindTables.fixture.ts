/** Hand-assembled ELF images with .eh_frame CIE/FDE records and .eh_frame_hdr. */

export const UNWIND_FN_A = 0x400100;
export const UNWIND_FN_A_SIZE = 0x20;
export const UNWIND_FN_B = 0x400180;
export const UNWIND_FN_B_SIZE = 0x30;
export const UNWIND_PERSONALITY = 0x400200;
export const UNWIND_LSDA = 0x400240;
export const UNWIND_TEXT_VA = 0x400000;
export const UNWIND_TEXT_SIZE = 0x300;
export const UNWIND_EH_VA = 0x401000;
export const UNWIND_HDR_VA = 0x402000;
export const UNWIND_MISMATCH_START = 0x400300;
export const UNWIND_DEBUG_VA = 0x403000;
export const UNWIND_GOT_VA = 0x404000;
export const UNWIND_DUPLICATE_VA = 0x405000;
/** Leading `.symtab` entries in the combined symbol-cap fixture. */
export const UNWIND_CAP_SYMTAB_ENTRIES = 40000;
/** `.dynsym` entries in the combined symbol-cap fixture; `alpha` is last. */
export const UNWIND_CAP_DYNSYM_ENTRIES = 30000;
/** First start of the `suffixNames` FDEs, 4 bytes apart. */
export const UNWIND_SUFFIX_VA = 0x410000;

export interface ElfUnwindFixtureOptions {
  readonly bits?: 32 | 64;
  readonly little?: boolean;
  readonly machine?: number;
  /**
   * Default `mismatch` stores a search-table start that is not an FDE.
   * `duplicate-row` repeats the second row; `shared-fde` points both rows at
   * the first FDE while naming both starts.
   */
  readonly header?:
    | "mismatch"
    | "match"
    | "absent"
    | "duplicate-row"
    | "shared-fde";
  readonly debugFrame?: boolean;
  readonly symbolSource?: "symtab" | "dynsym" | "none";
  /** First CIE uses version 3 and a ULEB return-address register. */
  readonly version3?: boolean;
  /** Cut the second FDE after its length word. */
  readonly truncate?: boolean;
  /** Non-zero byte after a real terminator, still inside .eh_frame. */
  readonly trailingByte?: boolean;
  readonly type?: number;
  /** When false, the image has no `.eh_frame` or `.eh_frame_hdr`. */
  readonly unwind?: boolean;
  /** Declare one unwind section as SHT_NOBITS or extending past end of file. */
  readonly backing?: {
    readonly section: ".eh_frame" | ".eh_frame_hdr" | ".debug_frame";
    readonly kind: "nobits" | "past-eof";
  };
  /**
   * First CIE uses `datarel|sdata4`. `got` encodes the first FDE start
   * against a `.got.plt` section; `none` has no GOT and encodes it against the
   * `.eh_frame_hdr` address instead. `dynamic` declares the GOT only through
   * a `.dynamic` DT_PLTGOT entry.
   */
  readonly datarel?: "got" | "none" | "dynamic";
  /**
   * First CIE and first FDE use the 0xffffffff extended (64-bit) length
   * escape; their CIE ID / CIE pointer stays 4 bytes, as `.eh_frame` requires.
   */
  readonly extendedLength?: boolean;
  /**
   * Declared `.eh_frame_hdr` fde_count, overriding the real row count. A
   * bigint is written as `DW_EH_PE_udata8`. `"omit"` writes the
   * `DW_EH_PE_omit` count and table encodings GNU ld uses for a header with
   * no search table.
   */
  readonly headerCount?: number | bigint | "omit";
  /** Declare a second, ignored section with this name. */
  readonly duplicate?: ".eh_frame" | ".eh_frame_hdr";
  /** `.symtab` and `.dynsym` each under 65536 entries, together over it. */
  readonly symbolCap?: boolean;
  /** Second FDE stores a raw zero pcrel LSDA pointer (no LSDA). */
  readonly zeroLsda?: boolean;
  /**
   * Insert an FDE with a raw zero pcrel initial location after the first,
   * as a linker leaves for a discarded function. It has no header row.
   */
  readonly discardedFde?: boolean;
  /**
   * First CIE is `zXR`: an unrecognized `X` (one data byte) precedes the `R`
   * pointer encoding.
   */
  readonly unknownAugmentation?: boolean;
  /**
   * First CIE uses `pcrel|udata4` (ELF32) or `pcrel|udata8` (ELF64), so the
   * first FDE start stores the unsigned two's-complement distance and only
   * resolves after wrapping at the address width. `size` overrides that FDE's
   * unsigned address range.
   */
  readonly unsignedPcrel?: { readonly size?: number };
  /** Append this many `zR` CIEs that no FDE references, before the terminator. */
  readonly extraCies?: number;
  /**
   * First CIE uses `indirect|pcrel|sdata4`, so the first FDE initial location
   * names a pointer slot rather than its function.
   */
  readonly indirectStart?: boolean;
  /** Second CIE stores a raw zero `indirect|pcrel|sdata4` personality. */
  readonly nullPersonality?: boolean;
  /**
   * `.symtab` holds `symbols` entries at distinct addresses, the first at
   * `UNWIND_FN_A`, all naming one `bytes`-byte string.
   */
  readonly sharedName?: { readonly symbols: number; readonly bytes: number };
  /**
   * Append this many 4-byte FDEs from `UNWIND_SUFFIX_VA`, each named by a
   * distinct suffix of one 65535-byte string, so the names are long and
   * pairwise different.
   */
  readonly suffixNames?: number;
  /** `alpha` at `UNWIND_FN_A` is a global `STT_GNU_IFUNC` resolver symbol. */
  readonly ifunc?: boolean;
  /** Append this many `S` letters to the first CIE's augmentation. */
  readonly longAugmentation?: number;
}

class Writer {
  #buf = Buffer.alloc(64);
  #len = 0;
  readonly #little: boolean;

  constructor(little: boolean) {
    this.#little = little;
  }

  get length(): number {
    return this.#len;
  }

  #ensure(extra: number): void {
    if (this.#len + extra <= this.#buf.length) return;
    const next = Buffer.alloc(
      Math.max(this.#buf.length * 2, this.#len + extra),
    );
    this.#buf.copy(next, 0, 0, this.#len);
    this.#buf = next;
  }

  u8(value: number): void {
    this.#ensure(1);
    this.#buf[this.#len] = value & 0xff;
    this.#len += 1;
  }

  u32(value: number): void {
    this.#ensure(4);
    if (this.#little) this.#buf.writeUInt32LE(value >>> 0, this.#len);
    else this.#buf.writeUInt32BE(value >>> 0, this.#len);
    this.#len += 4;
  }

  i32(value: number): void {
    this.#ensure(4);
    if (this.#little) this.#buf.writeInt32LE(value | 0, this.#len);
    else this.#buf.writeInt32BE(value | 0, this.#len);
    this.#len += 4;
  }

  u64(value: number): void {
    this.#ensure(8);
    if (this.#little) this.#buf.writeBigUInt64LE(BigInt(value), this.#len);
    else this.#buf.writeBigUInt64BE(BigInt(value), this.#len);
    this.#len += 8;
  }

  u64Big(value: bigint): void {
    this.#ensure(8);
    if (this.#little) this.#buf.writeBigUInt64LE(value, this.#len);
    else this.#buf.writeBigUInt64BE(value, this.#len);
    this.#len += 8;
  }

  patchU64(offset: number, value: number): void {
    if (this.#little) this.#buf.writeBigUInt64LE(BigInt(value), offset);
    else this.#buf.writeBigUInt64BE(BigInt(value), offset);
  }

  patchU32(offset: number, value: number): void {
    if (this.#little) this.#buf.writeUInt32LE(value >>> 0, offset);
    else this.#buf.writeUInt32BE(value >>> 0, offset);
  }

  bytes(value: Buffer | string): void {
    const bytes =
      typeof value === "string" ? Buffer.from(value, "latin1") : value;
    this.#ensure(bytes.length);
    bytes.copy(this.#buf, this.#len);
    this.#len += bytes.length;
  }

  uleb(value: number): void {
    let rest = value >>> 0;
    do {
      let byte = rest & 0x7f;
      rest >>>= 7;
      if (rest !== 0) byte |= 0x80;
      this.u8(byte);
    } while (rest !== 0);
  }

  sleb(value: number): void {
    let rest = value;
    let more = true;
    while (more) {
      let byte = rest & 0x7f;
      rest >>= 7;
      const sign = (byte & 0x40) !== 0;
      if ((rest === 0 && !sign) || (rest === -1 && sign)) more = false;
      else byte |= 0x80;
      this.u8(byte);
    }
  }

  finish(): Buffer {
    return Buffer.from(this.#buf.subarray(0, this.#len));
  }
}

const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

const write16 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt16BE(value, offset);
};

const write32 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt32LE(value >>> 0, offset);
  else bytes.writeUInt32BE(value >>> 0, offset);
};

const writeWord = (
  bytes: Buffer,
  offset: number,
  value: number,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (bits === 64) {
    if (little) bytes.writeBigUInt64LE(BigInt(value), offset);
    else bytes.writeBigUInt64BE(BigInt(value), offset);
    return;
  }
  write32(bytes, offset, value, little);
};

interface BuiltFrame {
  readonly bytes: Buffer;
  readonly fdeOffsets: readonly number[];
}

/** The first CIE's `R` encoding for the selected frame options. */
const firstPointerEncoding = (options: {
  readonly datarelBase?: number;
  readonly indirectStart?: boolean;
  readonly unsignedPcrel?: { readonly bits: 32 | 64 };
}): number => {
  if (options.unsignedPcrel !== undefined)
    return options.unsignedPcrel.bits === 64 ? 0x14 : 0x13;
  if (options.datarelBase !== undefined) return 0x3b;
  return options.indirectStart === true ? 0x9b : 0x1b;
};

/** Two CIEs (`zRS` and `zPLRB`) and two pcrel/sdata4 FDEs, then a terminator. */
const buildUnwindFrame = (
  ehVa: number,
  little: boolean,
  options: {
    readonly version3: boolean;
    readonly functions: 1 | 2;
    readonly truncate: boolean;
    readonly trailingByte: boolean;
    readonly signalFrame: boolean;
    readonly datarelBase?: number;
    readonly extendedLength?: boolean;
    readonly zeroLsda?: boolean;
    readonly discardedFde?: boolean;
    readonly unknownAugmentation?: boolean;
    readonly extraCies?: number;
    readonly unsignedPcrel?: {
      readonly bits: 32 | 64;
      readonly size?: number;
    };
    readonly indirectStart?: boolean;
    readonly nullPersonality?: boolean;
    readonly suffixFdes?: number;
    readonly longAugmentation?: number;
  },
): BuiltFrame => {
  const w = new Writer(little);
  const fdeOffsets: number[] = [];
  const extended = new Set<number>();
  const begin = (wide = false): number => {
    const at = w.length;
    if (wide) {
      extended.add(at);
      w.u32(0xffffffff);
      w.u64(0);
    } else w.u32(0);
    return at;
  };
  const end = (at: number): void => {
    if (extended.has(at)) w.patchU64(at + 4, w.length - (at + 12));
    else w.patchU32(at, w.length - (at + 4));
  };
  const wide = options.extendedLength === true;
  const pcrel = (target: number): void => {
    w.i32(target - (ehVa + w.length));
  };

  const unknown = options.unknownAugmentation === true;
  const unsigned = options.unsignedPcrel;
  const cie0 = begin(wide);
  w.u32(0);
  w.u8(options.version3 ? 3 : 1);
  w.bytes(
    `${unknown ? "zXR" : "zR"}${options.signalFrame ? "S" : ""}${"S".repeat(options.longAugmentation ?? 0)}\0`,
  );
  w.uleb(1);
  w.sleb(-4);
  if (options.version3) w.uleb(128);
  else w.u8(16);
  w.uleb(unknown ? 2 : 1);
  if (unknown) w.u8(0);
  w.u8(firstPointerEncoding(options));
  w.u8(0);
  end(cie0);

  const fde0 = begin(wide);
  fdeOffsets.push(fde0);
  w.u32(w.length - cie0);
  if (unsigned !== undefined) {
    const distance = BigInt(UNWIND_FN_A - (ehVa + w.length));
    if (unsigned.bits === 64) {
      w.u64Big(BigInt.asUintN(64, distance));
      w.u64Big(BigInt(unsigned.size ?? UNWIND_FN_A_SIZE));
    } else {
      w.u32(Number(BigInt.asUintN(32, distance)));
      w.u32(unsigned.size ?? UNWIND_FN_A_SIZE);
    }
  } else {
    if (options.datarelBase === undefined) pcrel(UNWIND_FN_A);
    else w.i32(UNWIND_FN_A - options.datarelBase);
    w.i32(UNWIND_FN_A_SIZE);
  }
  w.uleb(0);
  w.u8(0);
  end(fde0);

  if (options.discardedFde === true) {
    const dropped = begin();
    w.u32(w.length - cie0);
    w.i32(0);
    w.i32(0x10);
    w.uleb(0);
    w.u8(0);
    end(dropped);
  }

  if (options.functions === 2) {
    const cie1 = begin();
    w.u32(0);
    w.u8(1);
    w.bytes("zPLRB\0");
    w.uleb(1);
    w.sleb(-4);
    w.u8(17);
    w.uleb(7);
    w.u8(0x9b);
    if (options.nullPersonality === true) w.i32(0);
    else pcrel(UNWIND_PERSONALITY);
    w.u8(0x1b);
    w.u8(0x1b);
    w.u8(0);
    end(cie1);

    const fde1 = begin();
    fdeOffsets.push(fde1);
    w.u32(w.length - cie1);
    pcrel(UNWIND_FN_B);
    w.i32(UNWIND_FN_B_SIZE);
    w.uleb(4);
    if (options.zeroLsda === true) w.i32(0);
    else pcrel(UNWIND_LSDA);
    w.u8(0);
    end(fde1);
  }

  for (let extra = 0; extra < (options.extraCies ?? 0); extra += 1) {
    const cie = begin();
    w.u32(0);
    w.u8(1);
    w.bytes("zR\0");
    w.uleb(1);
    w.sleb(-4);
    w.u8(16);
    w.uleb(1);
    w.u8(0x1b);
    end(cie);
  }

  writeSuffixFdes(w, cie0, ehVa, options.suffixFdes ?? 0);

  const finished = options.truncate ? fdeOffsets[1]! + 4 : w.length;
  if (!options.truncate) w.u32(0);
  if (options.trailingByte && !options.truncate) w.u8(1);
  const bytes = options.truncate
    ? Buffer.from(w.finish().subarray(0, finished))
    : w.finish();
  return { bytes, fdeOffsets };
};

/** 4-byte FDEs from `UNWIND_SUFFIX_VA` under the CIE at `cie`. */
const writeSuffixFdes = (
  w: Writer,
  cie: number,
  ehVa: number,
  count: number,
): void => {
  for (let index = 0; index < count; index += 1) {
    const at = w.length;
    w.u32(0);
    w.u32(w.length - cie);
    w.i32(UNWIND_SUFFIX_VA + index * 4 - (ehVa + w.length));
    w.i32(4);
    w.uleb(0);
    w.u8(0);
    w.patchU32(at, w.length - (at + 4));
  }
};

/** Search-table rows as `[initial location, FDE index]`. */
type HeaderRows = ReadonlyArray<readonly [number, number]>;

const buildHeader = (
  hdrVa: number,
  ehVa: number,
  fdeOffsets: readonly number[],
  rows: HeaderRows,
  little: boolean,
  count: number | bigint | "omit" = rows.length,
): Buffer => {
  const w = new Writer(little);
  w.u8(1);
  w.u8(0x1b);
  if (count === "omit") {
    w.u8(0xff);
    w.u8(0xff);
    w.i32(ehVa - (hdrVa + w.length));
    return w.finish();
  }
  w.u8(typeof count === "bigint" ? 0x04 : 0x03);
  w.u8(0x3b);
  w.i32(ehVa - (hdrVa + w.length));
  if (typeof count === "bigint") {
    const low = Number(BigInt.asUintN(32, count));
    const high = Number(count >> 32n);
    w.u32(little ? low : high);
    w.u32(little ? high : low);
  } else w.u32(count);
  for (const [start, fde] of rows) {
    w.i32(start - hdrVa);
    w.i32(ehVa + fdeOffsets[fde]! - hdrVa);
  }
  return w.finish();
};

const headerRows = (
  header: NonNullable<ElfUnwindFixtureOptions["header"]>,
): HeaderRows => {
  if (header === "duplicate-row")
    return [
      [UNWIND_FN_A, 0],
      [UNWIND_FN_B, 1],
      [UNWIND_FN_B, 1],
    ];
  if (header === "shared-fde")
    return [
      [UNWIND_FN_A, 0],
      [UNWIND_FN_B, 0],
    ];
  return [
    [UNWIND_FN_A, 0],
    [header === "match" ? UNWIND_FN_B : UNWIND_MISMATCH_START, 1],
  ];
};

interface SectionSpec {
  readonly name: string;
  readonly type: number;
  readonly flags: number;
  readonly address: number;
  readonly bytes: Buffer;
  readonly link: number;
  readonly entsize: number;
  readonly align: number;
  /** Extra declared `sh_size` beyond the written bytes. */
  readonly overhang?: number;
}

const buildSymbolTable = (
  bits: 32 | 64,
  little: boolean,
  ifunc = false,
): { readonly symbols: Buffer; readonly strings: Buffer } => {
  const strings = Buffer.from("\0alpha\0mid\0obj\0", "latin1");
  const width = bits === 64 ? 24 : 16;
  const symbols = Buffer.alloc(width * 4);
  const writeSymbol = (
    index: number,
    name: number,
    info: number,
    section: number,
    value: number,
    size: number,
  ): void => {
    const at = index * width;
    write32(symbols, at, name, little);
    if (bits === 64) {
      symbols[at + 4] = info;
      write16(symbols, at + 6, section, little);
      writeWord(symbols, at + 8, value, bits, little);
      writeWord(symbols, at + 16, size, bits, little);
      return;
    }
    writeWord(symbols, at + 4, value, bits, little);
    writeWord(symbols, at + 8, size, bits, little);
    symbols[at + 12] = info;
    write16(symbols, at + 14, section, little);
  };
  writeSymbol(1, 1, ifunc ? 0x1a : 0x12, 1, UNWIND_FN_A, UNWIND_FN_A_SIZE);
  writeSymbol(2, 7, 0x12, 1, UNWIND_FN_A + 4, 1);
  writeSymbol(3, 11, 0x11, 1, UNWIND_FN_A, UNWIND_FN_A_SIZE);
  return { symbols, strings };
};

/** Function symbols at distinct addresses from `UNWIND_FN_A`, all one name. */
const buildSharedNameSymbolTable = (
  bits: 32 | 64,
  little: boolean,
  shared: { readonly symbols: number; readonly bytes: number },
): { readonly symbols: Buffer; readonly strings: Buffer } => {
  const strings = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(shared.bytes, "n"),
    Buffer.from([0]),
  ]);
  const width = bits === 64 ? 24 : 16;
  const symbols = Buffer.alloc(width * (shared.symbols + 1));
  for (let index = 1; index <= shared.symbols; index += 1) {
    const at = index * width;
    const value = UNWIND_FN_A + (index - 1) * 2;
    write32(symbols, at, 1, little);
    if (bits === 64) {
      symbols[at + 4] = 0x12;
      write16(symbols, at + 6, 1, little);
      writeWord(symbols, at + 8, value, bits, little);
    } else {
      writeWord(symbols, at + 4, value, bits, little);
      symbols[at + 12] = 0x12;
      write16(symbols, at + 14, 1, little);
    }
  }
  return { symbols, strings };
};

/** One function symbol per `suffixNames` FDE, each at its own name suffix. */
const buildSuffixNameSymbolTable = (
  bits: 32 | 64,
  little: boolean,
  count: number,
): { readonly symbols: Buffer; readonly strings: Buffer } => {
  const strings = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(65535, "s"),
    Buffer.from([0]),
  ]);
  const width = bits === 64 ? 24 : 16;
  const symbols = Buffer.alloc(width * (count + 1));
  for (let index = 0; index < count; index += 1) {
    const at = (index + 1) * width;
    const value = UNWIND_SUFFIX_VA + index * 4;
    write32(symbols, at, 1 + index, little);
    if (bits === 64) {
      symbols[at + 4] = 0x12;
      write16(symbols, at + 6, 1, little);
      writeWord(symbols, at + 8, value, bits, little);
    } else {
      writeWord(symbols, at + 4, value, bits, little);
      symbols[at + 12] = 0x12;
      write16(symbols, at + 14, 1, little);
    }
  }
  return { symbols, strings };
};

/** Zeroed (skipped) entries, then `alpha` at the last `.dynsym` slot. */
const buildCapSymbolTables = (
  bits: 32 | 64,
  little: boolean,
): {
  readonly symtab: Buffer;
  readonly dynsym: Buffer;
  readonly strings: Buffer;
} => {
  const width = bits === 64 ? 24 : 16;
  const symtab = Buffer.alloc(width * UNWIND_CAP_SYMTAB_ENTRIES);
  const dynsym = Buffer.alloc(width * UNWIND_CAP_DYNSYM_ENTRIES);
  const at = (UNWIND_CAP_DYNSYM_ENTRIES - 1) * width;
  write32(dynsym, at, 1, little);
  if (bits === 64) {
    dynsym[at + 4] = 0x12;
    write16(dynsym, at + 6, 1, little);
    writeWord(dynsym, at + 8, UNWIND_FN_A, bits, little);
  } else {
    writeWord(dynsym, at + 4, UNWIND_FN_A, bits, little);
    dynsym[at + 12] = 0x12;
    write16(dynsym, at + 14, 1, little);
  }
  return { symtab, dynsym, strings: Buffer.from("\0alpha\0", "latin1") };
};

const writeSectionHeader = (
  bytes: Buffer,
  offset: number,
  section: SectionSpec,
  nameOffset: number,
  fileOffset: number,
  bits: 32 | 64,
  little: boolean,
): void => {
  const declaredSize = section.bytes.length + (section.overhang ?? 0);
  write32(bytes, offset, nameOffset, little);
  write32(bytes, offset + 4, section.type, little);
  writeWord(bytes, offset + 8, section.flags, bits, little);
  if (bits === 64) {
    writeWord(bytes, offset + 16, section.address, bits, little);
    writeWord(bytes, offset + 24, fileOffset, bits, little);
    writeWord(bytes, offset + 32, declaredSize, bits, little);
    write32(bytes, offset + 40, section.link, little);
    writeWord(bytes, offset + 48, section.align, bits, little);
    writeWord(bytes, offset + 56, section.entsize, bits, little);
    return;
  }
  writeWord(bytes, offset + 12, section.address, bits, little);
  writeWord(bytes, offset + 16, fileOffset, bits, little);
  writeWord(bytes, offset + 20, declaredSize, bits, little);
  write32(bytes, offset + 24, section.link, little);
  writeWord(bytes, offset + 32, section.align, bits, little);
  writeWord(bytes, offset + 36, section.entsize, bits, little);
};

/** Option-driven GOT, duplicate, and combined-cap symbol sections. */
const addOptionalSections = (
  sections: SectionSpec[],
  options: ElfUnwindFixtureOptions,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (options.datarel === "got")
    sections.push({
      name: ".got.plt",
      type: 1,
      flags: 3,
      address: UNWIND_GOT_VA,
      bytes: Buffer.alloc(24),
      link: 0,
      entsize: 8,
      align: 8,
    });
  if (options.datarel === "dynamic") {
    const width = bits === 64 ? 16 : 8;
    const dynamic = Buffer.alloc(width * 2);
    // DT_PLTGOT, then DT_NULL.
    writeWord(dynamic, 0, 3, bits, little);
    writeWord(dynamic, width / 2, UNWIND_GOT_VA, bits, little);
    sections.push({
      name: ".dynamic",
      type: 6,
      flags: 3,
      address: UNWIND_GOT_VA - 0x100,
      bytes: dynamic,
      link: 0,
      entsize: width,
      align: 8,
    });
  }
  if (options.duplicate !== undefined) {
    const original = sections.find(
      (section) => section.name === options.duplicate,
    );
    if (original !== undefined)
      sections.push({ ...original, address: UNWIND_DUPLICATE_VA });
  }
  if (options.symbolCap === true) {
    const cap = buildCapSymbolTables(bits, little);
    const strings = sections.length + 3;
    const table = (name: string, type: number, bytes: Buffer): SectionSpec => ({
      name,
      type,
      flags: 0,
      address: 0,
      bytes,
      link: strings,
      entsize: bits === 64 ? 24 : 16,
      align: 8,
    });
    sections.push(
      table(".symtab", 2, cap.symtab),
      table(".dynsym", 11, cap.dynsym),
      {
        name: ".strtab",
        type: 3,
        flags: 0,
        address: 0,
        bytes: cap.strings,
        link: 0,
        entsize: 0,
        align: 1,
      },
    );
  }
};

/** Redeclare one unwind section as SHT_NOBITS or running past end of file. */
const applyBacking = (
  sections: SectionSpec[],
  backing: ElfUnwindFixtureOptions["backing"],
): void => {
  if (backing !== undefined) {
    const index = sections.findIndex(
      (section) => section.name === backing.section,
    );
    const target = sections[index];
    if (target !== undefined)
      sections[index] =
        backing.kind === "nobits"
          ? { ...target, type: 8 }
          : { ...target, overhang: 0x100000 };
  }
};

/** ELF32/ELF64 image whose unwind tables are assembled in this file. */
export const elfUnwindFixture = (
  options: ElfUnwindFixtureOptions = {},
): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const header = options.header ?? "mismatch";
  const unwind = options.unwind !== false;
  const frame = unwind
    ? buildUnwindFrame(UNWIND_EH_VA, little, {
        version3: options.version3 ?? false,
        functions: 2,
        truncate: options.truncate ?? false,
        trailingByte: options.trailingByte ?? false,
        signalFrame: true,
        ...(options.datarel === undefined
          ? {}
          : {
              datarelBase:
                options.datarel === "none" ? UNWIND_HDR_VA : UNWIND_GOT_VA,
            }),
        extendedLength: options.extendedLength ?? false,
        zeroLsda: options.zeroLsda ?? false,
        discardedFde: options.discardedFde ?? false,
        unknownAugmentation: options.unknownAugmentation ?? false,
        extraCies: options.extraCies ?? 0,
        indirectStart: options.indirectStart ?? false,
        nullPersonality: options.nullPersonality ?? false,
        suffixFdes: options.suffixNames ?? 0,
        longAugmentation: options.longAugmentation ?? 0,
        ...(options.unsignedPcrel === undefined
          ? {}
          : { unsignedPcrel: { ...options.unsignedPcrel, bits } }),
      })
    : null;
  const hdr =
    !unwind || header === "absent" || frame === null
      ? null
      : buildHeader(
          UNWIND_HDR_VA,
          UNWIND_EH_VA,
          frame.fdeOffsets,
          headerRows(header),
          little,
          options.headerCount,
        );
  const symbols =
    (options.symbolSource ?? "symtab") === "none" || options.symbolCap === true
      ? null
      : options.sharedName !== undefined
        ? buildSharedNameSymbolTable(bits, little, options.sharedName)
        : options.suffixNames !== undefined
          ? buildSuffixNameSymbolTable(bits, little, options.suffixNames)
          : buildSymbolTable(bits, little, options.ifunc === true);
  const debug =
    options.debugFrame === false || !unwind ? null : Buffer.alloc(4);
  const sections: SectionSpec[] = [
    {
      name: ".text",
      type: 1,
      flags: 6,
      address: UNWIND_TEXT_VA,
      bytes: Buffer.alloc(UNWIND_TEXT_SIZE),
      link: 0,
      entsize: 0,
      align: 16,
    },
  ];
  if (frame !== null)
    sections.push({
      name: ".eh_frame",
      type: 1,
      flags: 2,
      address: UNWIND_EH_VA,
      bytes: frame.bytes,
      link: 0,
      entsize: 0,
      align: 8,
    });
  if (hdr !== null)
    sections.push({
      name: ".eh_frame_hdr",
      type: 1,
      flags: 2,
      address: UNWIND_HDR_VA,
      bytes: hdr,
      link: 0,
      entsize: 0,
      align: 4,
    });
  if (debug !== null)
    sections.push({
      name: ".debug_frame",
      type: 1,
      flags: 0,
      address: UNWIND_DEBUG_VA,
      bytes: debug,
      link: 0,
      entsize: 0,
      align: 4,
    });
  addOptionalSections(sections, options, bits, little);
  const stringIndex = symbols === null ? 0 : sections.length + 2;
  if (symbols !== null) {
    sections.push({
      name: options.symbolSource === "dynsym" ? ".dynsym" : ".symtab",
      type: options.symbolSource === "dynsym" ? 11 : 2,
      flags: 0,
      address: 0,
      bytes: symbols.symbols,
      link: stringIndex,
      entsize: bits === 64 ? 24 : 16,
      align: 8,
    });
    sections.push({
      name: ".strtab",
      type: 3,
      flags: 0,
      address: 0,
      bytes: symbols.strings,
      link: 0,
      entsize: 0,
      align: 1,
    });
  }
  applyBacking(sections, options.backing);
  sections.push({
    name: ".shstrtab",
    type: 3,
    flags: 0,
    address: 0,
    bytes: Buffer.alloc(0),
    link: 0,
    entsize: 0,
    align: 1,
  });
  return writeSectionedElf(sections, {
    bits,
    little,
    type: options.type ?? 3,
    machine: options.machine ?? (bits === 64 ? 62 : 20),
  });
};

/** Lay out sections after the ELF header, then append the section header table. */
const writeSectionedElf = (
  sections: SectionSpec[],
  {
    bits,
    little,
    type,
    machine,
  }: {
    readonly bits: 32 | 64;
    readonly little: boolean;
    readonly type: number;
    readonly machine: number;
  },
): Buffer => {
  let shstr = "\0";
  const nameOffsets = [0];
  for (const section of sections) {
    nameOffsets.push(shstr.length);
    shstr += `${section.name}\0`;
  }
  const shstrtab = Buffer.from(shstr, "latin1");
  sections[sections.length - 1] = {
    ...sections[sections.length - 1]!,
    bytes: shstrtab,
  };
  const headerSize = bits === 64 ? 64 : 52;
  const shentsize = bits === 64 ? 64 : 40;
  const shnum = sections.length + 1;
  let cursor = alignTo(headerSize, 8);
  const fileOffsets: number[] = [];
  for (const section of sections) {
    cursor = alignTo(cursor, section.align);
    fileOffsets.push(cursor);
    cursor += section.bytes.length;
  }
  const shoff = alignTo(cursor, 8);
  const bytes = Buffer.alloc(shoff + shnum * shentsize);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = bits === 64 ? 2 : 1;
  bytes[5] = little ? 1 : 2;
  bytes[6] = 1;
  write16(bytes, 16, type, little);
  write16(bytes, 18, machine, little);
  write32(bytes, 20, 1, little);
  write16(bytes, bits === 64 ? 52 : 40, headerSize, little);
  write16(bytes, bits === 64 ? 54 : 42, bits === 64 ? 56 : 32, little);
  writeWord(bytes, bits === 64 ? 40 : 32, shoff, bits, little);
  write16(bytes, bits === 64 ? 58 : 46, shentsize, little);
  write16(bytes, bits === 64 ? 60 : 48, shnum, little);
  write16(bytes, bits === 64 ? 62 : 50, shnum - 1, little);
  sections.forEach((section, index) => {
    const fileOffset = fileOffsets[index]!;
    section.bytes.copy(bytes, fileOffset);
    writeSectionHeader(
      bytes,
      shoff + (index + 1) * shentsize,
      section,
      nameOffsets[index + 1]!,
      fileOffset,
      bits,
      little,
    );
  });
  return bytes;
};

interface SectionlessNamedSection {
  readonly name: string;
  readonly address: number;
  readonly offset: number;
  readonly size: number;
  readonly flags?: number;
}

/** Section headers the sectionless fixture declares for its `sections` option. */
const sectionlessNamedSections = (
  options: {
    readonly sections?: ".eh_frame" | ".eh_frame_hdr";
    readonly nonAllocOverlay?: boolean;
  },
  layout: {
    readonly ehVa: number;
    readonly ehOff: number;
    readonly ehSize: number;
    readonly hdrVa: number;
    readonly hdrOff: number;
    readonly hdrSize: number;
  },
): SectionlessNamedSection[] => {
  if (options.sections === undefined) return [];
  const named: SectionlessNamedSection[] = [];
  if (options.nonAllocOverlay === true)
    named.push({
      name: ".comment",
      address: 0x400000,
      offset: 8,
      size: UNWIND_FN_A - 0x400000 + 0x10,
      flags: 0,
    });
  named.push({
    name: ".eh_frame",
    address: layout.ehVa,
    offset: layout.ehOff,
    size: layout.ehSize,
  });
  if (options.sections === ".eh_frame_hdr")
    named.push({
      name: ".eh_frame_hdr",
      address: layout.hdrVa,
      offset: layout.hdrOff,
      size: layout.hdrSize,
    });
  return named;
};

/**
 * ELF64 image with PT_LOAD plus PT_GNU_EH_FRAME and one agreeing FDE. By
 * default it has no section headers. `sections: ".eh_frame"` adds section
 * headers naming only `.eh_frame`, so the header comes from PT_GNU_EH_FRAME.
 * `".eh_frame_hdr"` also names `.eh_frame_hdr` while PT_GNU_EH_FRAME declares
 * four fewer bytes than that section. `nonAllocOverlay` puts a non-ALLOC
 * `.comment` section first, whose sh_addr covers `.eh_frame` and the function
 * start but whose sh_offset is 8 bytes off the PT_LOAD mapping.
 * `unterminated` drops the `.eh_frame` terminator and appends bytes that are
 * not in the search table: a well-formed FDE for `UNWIND_FN_B`
 * (`"decodable"`), or an FDE whose CIE pointer names the first FDE followed
 * by that well-formed FDE (`"undecodable"`), or a CIE with an unrecognized
 * augmentation letter followed by that well-formed FDE (`"rejected-cie"`).
 * `emptyTable` declares no search-table rows. `duplicateProgramHeader`
 * declares a second PT_GNU_EH_FRAME naming the same bytes.
 */
export const elfUnwindSectionlessFixture = (
  options: {
    readonly sections?: ".eh_frame" | ".eh_frame_hdr";
    readonly nonAllocOverlay?: boolean;
    readonly unterminated?: "decodable" | "undecodable" | "rejected-cie";
    readonly emptyTable?: boolean;
    readonly duplicateProgramHeader?: boolean;
  } = {},
): Buffer => {
  const little = true;
  const bits = 64 as const;
  const phnum = options.duplicateProgramHeader === true ? 3 : 2;
  const ehOff = 64 + phnum * 56;
  const ehVa = 0x400000 + ehOff;
  const built = buildUnwindFrame(ehVa, little, {
    version3: false,
    functions: 1,
    truncate: false,
    trailingByte: false,
    signalFrame: false,
  });
  const frame =
    options.unterminated === undefined
      ? built
      : {
          fdeOffsets: built.fdeOffsets,
          bytes: unterminatedFrame(
            built.bytes,
            built.fdeOffsets[0]!,
            ehVa,
            options.unterminated,
          ),
        };
  const hdrOff = alignTo(ehOff + frame.bytes.length, 4);
  const hdrVa = 0x400000 + hdrOff;
  const hdr = buildHeader(
    hdrVa,
    ehVa,
    frame.fdeOffsets,
    options.emptyTable === true ? [] : [[UNWIND_FN_A, 0]],
    little,
  );
  const fileSize = hdrOff + hdr.length;
  const named = sectionlessNamedSections(options, {
    ehVa,
    ehOff,
    ehSize: frame.bytes.length,
    hdrVa,
    hdrOff,
    hdrSize: hdr.length,
  });
  let shstr = "\0";
  const nameOffsets = named.map((section) => {
    const at = shstr.length;
    shstr += `${section.name}\0`;
    return at;
  });
  const shstrName = shstr.length;
  shstr += ".shstrtab\0";
  const shstrOff = fileSize;
  const shoff = alignTo(shstrOff + shstr.length, 8);
  const shnum = named.length + 2;
  const bytes = Buffer.alloc(
    options.sections === undefined ? fileSize : shoff + shnum * 64,
  );
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes[6] = 1;
  write16(bytes, 16, 3, little);
  write16(bytes, 18, 62, little);
  write32(bytes, 20, 1, little);
  writeWord(bytes, 32, 64, bits, little);
  write16(bytes, 52, 64, little);
  write16(bytes, 54, 56, little);
  write16(bytes, 56, phnum, little);
  write16(bytes, 58, 64, little);
  const load = 64;
  write32(bytes, load, 1, little);
  write32(bytes, load + 4, 5, little);
  writeWord(bytes, load + 16, 0x400000, bits, little);
  writeWord(bytes, load + 32, fileSize, bits, little);
  writeWord(bytes, load + 40, fileSize, bits, little);
  writeWord(bytes, load + 48, 0x1000, bits, little);
  const gnu = 64 + 56;
  write32(bytes, gnu, 0x6474e550, little);
  write32(bytes, gnu + 4, 4, little);
  writeWord(bytes, gnu + 8, hdrOff, bits, little);
  writeWord(bytes, gnu + 16, hdrVa, bits, little);
  writeWord(bytes, gnu + 32, hdr.length, bits, little);
  writeWord(bytes, gnu + 40, hdr.length, bits, little);
  writeWord(bytes, gnu + 48, 4, bits, little);
  if (phnum === 3) bytes.copy(bytes, gnu + 56, gnu, gnu + 56);
  frame.bytes.copy(bytes, ehOff);
  hdr.copy(bytes, hdrOff);
  if (options.sections === ".eh_frame_hdr")
    writeWord(bytes, gnu + 32, hdr.length - 4, bits, little);
  if (options.sections !== undefined) {
    Buffer.from(shstr, "latin1").copy(bytes, shstrOff);
    writeWord(bytes, 40, shoff, bits, little);
    write16(bytes, 60, shnum, little);
    write16(bytes, 62, shnum - 1, little);
    const specs = [
      ...named.map((section, index) => ({
        spec: {
          name: section.name,
          type: 1,
          flags: section.flags ?? 2,
          address: section.address,
          bytes: Buffer.alloc(section.size),
          link: 0,
          entsize: 0,
          align: 4,
        },
        nameOffset: nameOffsets[index]!,
        fileOffset: section.offset,
      })),
      {
        spec: {
          name: ".shstrtab",
          type: 3,
          flags: 0,
          address: 0,
          bytes: Buffer.alloc(shstr.length),
          link: 0,
          entsize: 0,
          align: 1,
        },
        nameOffset: shstrName,
        fileOffset: shstrOff,
      },
    ];
    specs.forEach(({ spec, nameOffset, fileOffset }, index) =>
      writeSectionHeader(
        bytes,
        shoff + (index + 1) * 64,
        spec,
        nameOffset,
        fileOffset,
        bits,
        little,
      ),
    );
  }
  return bytes;
};

/**
 * Replace a frame's zero terminator with FDE-shaped bytes the search table
 * does not name, as other data following an unterminated table would look.
 * Every appended FDE uses the frame's first CIE, at offset 0.
 */
const unterminatedFrame = (
  terminated: Buffer,
  firstFde: number,
  ehVa: number,
  kind: "decodable" | "undecodable" | "rejected-cie",
): Buffer => {
  const w = new Writer(true);
  w.bytes(terminated.subarray(0, terminated.length - 4));
  const fde = (ciePointerTarget: number): void => {
    const at = w.length;
    w.u32(14);
    w.u32(w.length - ciePointerTarget);
    w.i32(UNWIND_FN_B - (ehVa + w.length));
    w.i32(UNWIND_FN_B_SIZE);
    w.uleb(0);
    w.u8(0);
    if (w.length !== at + 18) throw new Error("FDE size mismatch");
  };
  if (kind === "undecodable") fde(firstFde);
  if (kind === "rejected-cie") {
    const at = w.length;
    w.u32(0);
    w.u32(0);
    w.u8(1);
    w.bytes("zXR\0");
    w.uleb(1);
    w.sleb(-4);
    w.u8(16);
    w.uleb(2);
    w.u8(0);
    w.u8(0x1b);
    w.patchU32(at, w.length - (at + 4));
  }
  fde(0);
  return w.finish();
};

/** Named sections and no unwind tables. Absence is observable. */
export const elfUnwindAbsentFixture = (): Buffer =>
  elfUnwindFixture({
    unwind: false,
    debugFrame: false,
    symbolSource: "none",
  });
