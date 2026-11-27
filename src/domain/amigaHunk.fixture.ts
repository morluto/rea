import {
  HUNK_BSS,
  HUNK_CODE,
  HUNK_DATA,
  HUNK_DEBUG,
  HUNK_DREL32,
  HUNK_END,
  HUNK_HEADER,
  HUNK_NAME,
  HUNK_RELOC32,
  HUNK_RELOC32SHORT,
  HUNK_SYMBOL,
  HUNK_UNIT,
  HUNKF_CHIP,
  HUNKF_EXTENDED,
  HUNKF_FAST,
  HUNK_SIZE_MASK,
} from "./amigaHunk.js";

interface AmigaHunkRelocSpec {
  readonly kind: "reloc32" | "reloc32short" | "drel32";
  readonly target: number;
  readonly offsets: readonly number[];
}

interface AmigaHunkSpec {
  readonly type: "code" | "data" | "bss";
  readonly bytes?: Buffer;
  /** BSS block size in longwords. Code and data use `bytes`. */
  readonly longwords?: number;
  /** Header size when it should differ from the stored block. */
  readonly declaredLongwords?: number;
  readonly memory?: "any" | "chip" | "fast" | "extended";
  readonly extendedFlags?: number;
  readonly name?: string;
  readonly relocs?: readonly AmigaHunkRelocSpec[];
  readonly symbols?: readonly {
    readonly name: string;
    readonly offset: number;
  }[];
  readonly debug?: Buffer;
  /** Extra bits OR-ed into the code, data or BSS type word. */
  readonly typeFlags?: number;
  /** Raw block type inserted after the body and before `HUNK_END`. */
  readonly unknownBeforeEnd?: number;
  readonly omitEnd?: boolean;
}

interface AmigaLoadFileOptions {
  readonly libraries?: readonly string[];
  readonly hunks?: readonly AmigaHunkSpec[];
  readonly firstHunk?: number;
  readonly lastHunk?: number;
  readonly tableSize?: number;
  readonly trailing?: Buffer;
}

interface AmigaObjectUnitSpec {
  readonly name: string;
  readonly hunks: readonly AmigaHunkSpec[];
}

const pad4 = (bytes: Buffer): Buffer => {
  const pad = (4 - (bytes.length % 4)) % 4;
  return pad === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(pad)]);
};

class Buf {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  u32(value: number): void {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    this.bytes(bytes);
  }

  u16(value: number): void {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value & 0xffff);
    this.bytes(bytes);
  }

  bytes(bytes: Buffer): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  name(text: string): void {
    const padded = pad4(
      Buffer.concat([Buffer.from(text, "latin1"), Buffer.from([0])]),
    );
    this.u32(padded.length / 4);
    this.bytes(padded);
  }

  align4(): void {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad !== 0) this.bytes(Buffer.alloc(pad));
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const storedLongwords = (hunk: AmigaHunkSpec): number => {
  if (hunk.type === "bss") return hunk.longwords ?? 0;
  return pad4(hunk.bytes ?? Buffer.alloc(0)).length / 4;
};

const memoryBits = (memory: AmigaHunkSpec["memory"]): number => {
  if (memory === "chip") return HUNKF_CHIP;
  if (memory === "fast") return HUNKF_FAST;
  if (memory === "extended") return HUNKF_EXTENDED;
  return 0;
};

const emitSize = (buf: Buf, hunk: AmigaHunkSpec): void => {
  const declared = hunk.declaredLongwords ?? storedLongwords(hunk);
  buf.u32((declared & HUNK_SIZE_MASK) | memoryBits(hunk.memory));
  if (hunk.memory === "extended") buf.u32(hunk.extendedFlags ?? 0);
};

const emitReloc = (
  buf: Buf,
  reloc: AmigaHunkRelocSpec,
  objectFile: boolean,
): void => {
  // Load-file 0x3F7 is the V37 16-bit short reloc. Object-file 0x3F7 is 32-bit.
  const short =
    reloc.kind === "reloc32short" || (reloc.kind === "drel32" && !objectFile);
  buf.u32(
    reloc.kind === "drel32"
      ? HUNK_DREL32
      : reloc.kind === "reloc32short"
        ? HUNK_RELOC32SHORT
        : HUNK_RELOC32,
  );
  if (short) {
    if (reloc.offsets.length > 0) {
      buf.u16(reloc.offsets.length);
      buf.u16(reloc.target);
      for (const offset of reloc.offsets) buf.u16(offset);
    }
    buf.u16(0);
    buf.align4();
    return;
  }
  if (reloc.offsets.length > 0) {
    buf.u32(reloc.offsets.length);
    buf.u32(reloc.target);
    for (const offset of reloc.offsets) buf.u32(offset);
  }
  buf.u32(0);
};

const emitBody = (buf: Buf, hunk: AmigaHunkSpec, objectFile: boolean): void => {
  if (hunk.name !== undefined) {
    buf.u32(HUNK_NAME);
    buf.name(hunk.name);
  }
  const id =
    hunk.type === "data"
      ? HUNK_DATA
      : hunk.type === "bss"
        ? HUNK_BSS
        : HUNK_CODE;
  const flags =
    (objectFile ? memoryBits(hunk.memory) : 0) | (hunk.typeFlags ?? 0);
  buf.u32((id | flags) >>> 0);
  if (objectFile && hunk.memory === "extended")
    buf.u32((hunk.extendedFlags ?? 0) >>> 0);
  if (hunk.type === "bss") buf.u32(hunk.longwords ?? 0);
  else {
    const payload = pad4(hunk.bytes ?? Buffer.alloc(0));
    buf.u32(payload.length / 4);
    buf.bytes(payload);
  }
  for (const reloc of hunk.relocs ?? []) emitReloc(buf, reloc, objectFile);
  if (hunk.symbols !== undefined && hunk.symbols.length > 0) {
    buf.u32(HUNK_SYMBOL);
    for (const symbol of hunk.symbols) {
      buf.name(symbol.name);
      buf.u32(symbol.offset);
    }
    buf.u32(0);
  }
  if (hunk.debug !== undefined) {
    const payload = pad4(hunk.debug);
    buf.u32(HUNK_DEBUG);
    buf.u32(payload.length / 4);
    buf.bytes(payload);
  }
  if (hunk.unknownBeforeEnd !== undefined) buf.u32(hunk.unknownBeforeEnd);
  if (hunk.omitEnd !== true) buf.u32(HUNK_END);
};

/** One synthetic `HUNK_HEADER` load file. */
export const amigaLoadFile = (options: AmigaLoadFileOptions = {}): Buffer => {
  const buf = new Buf();
  const hunks = options.hunks ?? [];
  const first = options.firstHunk ?? 0;
  const last =
    options.lastHunk ?? (hunks.length === 0 ? first : first + hunks.length - 1);
  buf.u32(HUNK_HEADER);
  for (const name of options.libraries ?? []) buf.name(name);
  buf.u32(0);
  const count = last >= first ? last - first + 1 : 0;
  buf.u32(options.tableSize ?? (count > 0 ? last + 1 : 0));
  buf.u32(first);
  buf.u32(last);
  if (last >= first && hunks.length > 0) {
    for (const hunk of hunks) emitSize(buf, hunk);
    for (const hunk of hunks) emitBody(buf, hunk, false);
  }
  if (options.trailing !== undefined) buf.bytes(options.trailing);
  return buf.build();
};

/** One synthetic object file of `HUNK_UNIT` blocks. */
export const amigaObjectFile = (
  units: readonly AmigaObjectUnitSpec[],
): Buffer => {
  const buf = new Buf();
  for (const unit of units) {
    buf.u32(HUNK_UNIT);
    buf.name(unit.name);
    for (const hunk of unit.hunks) emitBody(buf, hunk, true);
  }
  return buf.build();
};
