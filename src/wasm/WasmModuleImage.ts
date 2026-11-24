import { readLeb128, ULEB32, type Leb128Encoding } from "../domain/leb128.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { ParseFailureError } from "../domain/parseFailure.js";

/** The ParseFailure format of a wasm32 module image. */
const WASM_MODULE_FORMAT = "wasm-module";
const SLEB32: Leb128Encoding = { signed: true, bits: 32 };

/**
 * Static image of an uncompressed wasm32 module: function counts, the one
 * memory, the one funcref table as active MVP element segments fill it, and
 * the active data segments that form initial linear memory. Anything a
 * reader would have to evaluate or relocate is refused as unsupported.
 */

/** What a wasm module capacity maximum counts. */
export type WasmModuleLimitUnit = "entries" | "bytes";

/**
 * A module this reader cannot image. A capacity refusal is a ParseFailure
 * `limit` naming the exceeded WASM_MODULE_LIMITS entry and its unit.
 */
export class WasmModuleFailure extends ParseFailureError<
  "malformed" | "unsupported" | "limit"
> {
  /** What the exceeded maximum counts; set only for a limit. */
  readonly unit: WasmModuleLimitUnit | undefined;
  constructor(kind: "malformed" | "unsupported", message: string);
  constructor(
    kind: "limit",
    message: string,
    limit: {
      readonly name: keyof typeof WASM_MODULE_LIMITS;
      readonly unit: WasmModuleLimitUnit;
    },
  );
  constructor(
    kind: "malformed" | "unsupported" | "limit",
    message: string,
    limit?: {
      readonly name: keyof typeof WASM_MODULE_LIMITS;
      readonly unit: WasmModuleLimitUnit;
    },
  ) {
    super(
      kind === "limit" && limit !== undefined
        ? {
            kind,
            format: WASM_MODULE_FORMAT,
            detail: message,
            limit: {
              name: limit.name,
              maximum: WASM_MODULE_LIMITS[limit.name],
            },
          }
        : kind === "unsupported"
          ? {
              kind,
              format: WASM_MODULE_FORMAT,
              detail: message,
              undecodedContent: true,
            }
          : { kind: "malformed", format: WASM_MODULE_FORMAT, detail: message },
    );
    this.name = "WasmModuleFailure";
    this.unit = limit?.unit;
  }
}

/**
 * Bounds on what one read retains. A Unity 2022.3 release build has 6,535
 * data segments and 27,081 table slots; the limits leave wide headroom.
 */
export const WASM_MODULE_LIMITS = {
  inputBytes: 1 << 30,
  dataSegments: 1 << 18,
  elementSegments: 1 << 18,
  tableSlots: 1 << 21,
  linearMemoryBytes: 1 << 30,
  /** Zero bytes the view may add between and after segments; real builds add a few KiB. */
  linearMemoryGapBytes: 1 << 26,
} as const;

export const WASM_PAGE_BYTES = 65536;
/** wasm32 addresses 4 GiB, so a memory declares at most 65,536 pages. */
const WASM32_MEMORY_PAGES = 65536;
/** Zero bytes kept after the last data segment; wider than any record read across it. */
const LINEAR_MEMORY_TAIL_BYTES = 64;
/** Bytes copied into the view between yields. */
const LINEAR_MEMORY_COPY_BYTES = 1 << 20;

export interface WasmMemory {
  readonly initialPages: number;
  readonly maximumPages: number | null;
  /** True when the memory comes from the import section. */
  readonly imported: boolean;
}

export interface WasmDataSegment {
  /** Linear memory address of the first byte. */
  readonly offset: number;
  /** A view into the module bytes; it is not copied. */
  readonly bytes: Buffer;
}

/** Function index per filled slot of table 0. */
export interface WasmTableSlots {
  get(slot: number): number | undefined;
  /** Filled slots in slot order. */
  [Symbol.iterator](): Iterator<[slot: number, functionIndex: number]>;
}

const EMPTY_SLOT = 0xffffffff;

/**
 * Slots from the lowest filled one to the end of the highest, four bytes each.
 * A function index is below the module's u32 function count, so the all-ones
 * word never names a function and marks an unfilled slot.
 */
class DenseWasmTable implements WasmTableSlots {
  constructor(
    readonly low: number,
    readonly words: Uint32Array,
  ) {}
  get(slot: number): number | undefined {
    const value = this.words[slot - this.low];
    return value === undefined || value === EMPTY_SLOT ? undefined : value;
  }
  *[Symbol.iterator](): Iterator<[number, number]> {
    for (let i = 0; i < this.words.length; i++)
      if (this.words[i] !== EMPTY_SLOT) yield [this.low + i, this.words[i]!];
  }
}

export interface WasmModuleImage {
  readonly importedFunctionCount: number;
  /** Imported plus defined functions. */
  readonly functionCount: number;
  readonly memory: WasmMemory | null;
  /** Empty when table 0 is imported: its slots are unknown, not unfilled. */
  readonly table: WasmTableSlots;
  /** Table 0 comes from an import, so the host may fill slots no element segment writes. */
  readonly tableImported: boolean;
  readonly dataSegments: readonly WasmDataSegment[];
}

export interface WasmInitialLinearMemory {
  /** Address of `bytes[0]`: the lowest data segment start. */
  readonly address: number;
  readonly bytes: Buffer;
}

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const I32_CONST = 0x41;
const FUNCREF = 0x70;
const END = 0x0b;
/** Import, function, table, memory, element, data; others are skipped whole. */
const PARSED_SECTIONS = new Set([2, 3, 4, 5, 9, 10, 11]);
/** Required order of non-custom section ids; tag (13) sits after memory, data count (12) before code. */
const SECTION_ORDER = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];

const malformed = (message: string) =>
  new WasmModuleFailure("malformed", message);
const unsupported = (message: string) =>
  new WasmModuleFailure("unsupported", message);

class Cursor {
  constructor(
    readonly bytes: Buffer,
    public at: number,
    readonly end: number,
  ) {}
  byte(): number {
    if (this.at >= this.end) throw malformed(`truncated at byte ${this.at}`);
    return this.bytes[this.at++]!;
  }
  u32(): number {
    return Number(this.leb128(ULEB32, "u32"));
  }
  i32(): number {
    return Number(this.leb128(SLEB32, "i32"));
  }
  /** One 32-bit LEB128 through the shared decoder, with this reader's wording. */
  private leb128(encoding: Leb128Encoding, label: "u32" | "i32"): bigint {
    const start = this.at;
    const read = readLeb128(this.bytes, start, this.end, encoding);
    if ("value" in read) {
      this.at = read.next;
      return read.value;
    }
    if (read.failure === "truncated")
      throw malformed(`truncated at byte ${read.at}`);
    if (read.at - start >= 5)
      throw malformed(`${label} is longer than 5 bytes`);
    // The fifth byte holds bits 28 to 31; its upper bits must be zero or repeat the sign.
    throw malformed(
      label === "u32"
        ? "u32 overflows"
        : "i32 has unused bits set in its fifth byte",
    );
  }
  span(size: number): number {
    if (size > this.end - this.at)
      throw malformed(`truncated at byte ${this.at}`);
    const start = this.at;
    this.at += size;
    return start;
  }
  /** Limits valid within range `bound`: min <= bound, max <= bound and min <= max. */
  limits(label: string, bound: number): { min: number; max: number | null } {
    const flags = this.byte();
    // 0x02 shared, 0x04 memory64, 0x08 custom page size.
    if (flags > 1)
      throw unsupported(
        `${label} limits flags 0x${flags.toString(16)} are not read`,
      );
    const min = this.u32();
    const max = flags === 1 ? this.u32() : null;
    if (min > bound || (max !== null && max > bound))
      throw malformed(`${label} limits exceed ${bound}`);
    if (max !== null && max < min)
      throw malformed(`${label} limits maximum ${max} is below minimum ${min}`);
    return { min, max };
  }
  /** Only `i32.const n end`; global.get or extended forms need evaluation. */
  constOffset(label: string): number {
    const opcode = this.byte();
    if (opcode !== I32_CONST)
      throw unsupported(
        `${label} offset uses opcode 0x${opcode.toString(16)}, not i32.const`,
      );
    const value = this.i32();
    if (this.byte() !== END)
      throw unsupported(`${label} offset is an extended constant expression`);
    return value >>> 0;
  }
}

/** Records read between yields, so a large module does not block cancellation. */
const RECORDS_PER_YIELD = 4096;

/** Read the static image in yielding steps; the result shares `bytes` for segment views. */
export function* readWasmModuleImageSteps(
  bytes: Buffer,
): Generator<void, WasmModuleImage> {
  let work = 0;
  const tick = () => ++work % RECORDS_PER_YIELD === 0;
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(GZIP_MAGIC))
    throw unsupported("module is gzip compressed; decompress the .wasm first");
  if (bytes.length > WASM_MODULE_LIMITS.inputBytes)
    throw new WasmModuleFailure(
      "limit",
      `module has ${bytes.length} bytes, above ${WASM_MODULE_LIMITS.inputBytes}`,
      { name: "inputBytes", unit: "bytes" },
    );
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(WASM_MAGIC))
    throw malformed("not a WebAssembly module");
  const version = new BinaryReader(bytes, true, WASM_MODULE_FORMAT).u32(4);
  if (version !== 1) throw malformed(`WebAssembly version ${version} is not 1`);

  let importedFunctionCount = 0;
  let definedFunctionCount = 0;
  let memory: WasmMemory | null = null;
  let tables = 0;
  let tableMinimum: number | null = null;
  let tableImported = false;
  const elements: { base: number; functions: Uint32Array }[] = [];
  const dataSegments: WasmDataSegment[] = [];
  let slots = 0;
  let codeBodies: number | null = null;

  const addMemory = (cursor: Cursor, imported: boolean) => {
    const { min, max } = cursor.limits("memory", WASM32_MEMORY_PAGES);
    if (memory) throw unsupported("module has more than one memory");
    memory = { initialPages: min, maximumPages: max, imported };
  };
  const addTable = (cursor: Cursor, imported: boolean) => {
    // Element segments flags 0 fill a funcref table; any other table type is not read.
    const type = cursor.byte();
    if (type !== FUNCREF)
      throw unsupported(
        `table element type 0x${type.toString(16)} is not funcref`,
      );
    const { min } = cursor.limits("table", 0xffff_ffff);
    if (++tables > 1) throw unsupported("module has more than one table");
    tableMinimum = min;
    tableImported = imported;
  };

  let at = 8;
  let lastOrder = -1;
  while (at < bytes.length) {
    // Skipped custom sections still cost a header read each, so they count as work.
    if (tick()) yield;
    const head = new Cursor(bytes, at, bytes.length);
    const id = head.byte();
    const size = head.u32();
    if (size > bytes.length - head.at)
      throw malformed(`section ${id} ends past the module`);
    if (id !== 0) {
      // A repeated or reordered section would make the counts read below ambiguous.
      const order = SECTION_ORDER.indexOf(id);
      if (order < 0) throw malformed(`section id ${id} is unknown`);
      if (order <= lastOrder)
        throw malformed(`section ${id} is repeated or out of order`);
      lastOrder = order;
    }
    const body = new Cursor(bytes, head.at, head.at + size);
    if (id === 2) {
      for (let count = body.u32(); count > 0; count--) {
        if (tick()) yield;
        body.span(body.u32());
        body.span(body.u32());
        const kind = body.byte();
        if (kind === 0) {
          body.u32();
          importedFunctionCount++;
        } else if (kind === 1) addTable(body, true);
        else if (kind === 2) addMemory(body, true);
        else if (kind === 3) body.span(2);
        else if (kind === 4) throw unsupported("tag imports are not read");
        else throw malformed(`import kind ${kind} is unknown`);
      }
    } else if (id === 3) {
      definedFunctionCount = body.u32();
      for (let count = definedFunctionCount; count > 0; count--) {
        body.u32();
        if (tick()) yield;
      }
    } else if (id === 4) {
      for (let count = body.u32(); count > 0; count--) addTable(body, false);
    } else if (id === 5) {
      for (let count = body.u32(); count > 0; count--) addMemory(body, false);
    } else if (id === 9) {
      const count = body.u32();
      // The shortest element segment (flags, element kind and an empty vector)
      // takes three bytes, so a count the body cannot hold is a damaged
      // section, not one past the allowance.
      if (count * 3 > body.end - body.at)
        throw malformed(
          `section declares ${count} element segments in ${body.end - body.at} bytes`,
        );
      if (count > WASM_MODULE_LIMITS.elementSegments)
        throw new WasmModuleFailure(
          "limit",
          `module has ${count} element segments, above ${WASM_MODULE_LIMITS.elementSegments}`,
          { name: "elementSegments", unit: "entries" },
        );
      for (let index = 0; index < count; index++) {
        if (tick()) yield;
        const flags = body.u32();
        if (flags !== 0)
          throw unsupported(`element segment flags ${flags} are not read`);
        const base = body.constOffset("element segment");
        const length = body.u32();
        // Each slot holds a function index of at least one byte.
        if (length > body.end - body.at)
          throw malformed(
            `element segment declares ${length} slots in ${body.end - body.at} bytes`,
          );
        slots += length;
        if (slots > WASM_MODULE_LIMITS.tableSlots)
          throw new WasmModuleFailure(
            "limit",
            `element segments fill more than ${WASM_MODULE_LIMITS.tableSlots} slots`,
            { name: "tableSlots", unit: "entries" },
          );
        // Typed storage keeps a retained slot at four bytes.
        const functions = new Uint32Array(length);
        for (let slot = 0; slot < length; slot++) {
          functions[slot] = body.u32();
          if (tick()) yield;
        }
        // An empty segment still traps past the table, so its base is kept.
        elements.push({ base, functions });
      }
    } else if (id === 10) {
      // Each declared function needs a body; without one there is no code to link.
      codeBodies = body.u32();
      for (let count = codeBodies; count > 0; count--) {
        body.span(body.u32());
        if (tick()) yield;
      }
    } else if (id === 11) {
      const count = body.u32();
      // The shortest data segment (passive flag and an empty size) takes two
      // bytes; check that framing before the segment allowance.
      if (count * 2 > body.end - body.at)
        throw malformed(
          `section declares ${count} data segments in ${body.end - body.at} bytes`,
        );
      if (count > WASM_MODULE_LIMITS.dataSegments)
        throw new WasmModuleFailure(
          "limit",
          `module has ${count} data segments, above ${WASM_MODULE_LIMITS.dataSegments}`,
          { name: "dataSegments", unit: "entries" },
        );
      for (let index = 0; index < count; index++) {
        if (tick()) yield;
        const flags = body.u32();
        if (flags !== 0)
          throw unsupported(
            `data segment flags ${flags} (passive or explicit memory) are not read`,
          );
        const offset = body.constOffset("data segment");
        const length = body.u32();
        const start = body.span(length);
        dataSegments.push({
          offset,
          bytes: bytes.subarray(start, start + length),
        });
      }
    }
    if (PARSED_SECTIONS.has(id) && body.at !== body.end)
      throw malformed(`section ${id} has trailing bytes`);
    at = body.end;
  }

  if ((codeBodies ?? 0) !== definedFunctionCount)
    throw malformed(
      `module declares ${definedFunctionCount} functions but has ${codeBodies ?? 0} code bodies`,
    );
  const functionCount = importedFunctionCount + definedFunctionCount;
  const minimum = tableMinimum as number | null;
  if (elements.length > 0 && minimum === null)
    throw malformed("element segments name a table the module does not have");
  // The table spans the filled slots only, so a high base costs nothing, and
  // the span shares the slot allowance, which bounds it to four bytes a slot.
  let low = Infinity;
  let high = 0;
  for (const { base, functions } of elements) {
    // Instantiation traps when a segment ends past the initial table. An
    // imported table may be larger than its declared minimum, so only a
    // defined one is judged here; the caller refuses imported tables.
    if (!tableImported && base + functions.length > minimum!)
      throw malformed(
        `element segment at slot ${base} ends past the ${minimum} initial table slots`,
      );
    // An empty segment fills no slot, so it does not widen the span; an
    // imported table's slots are not determined, so none are kept.
    if (functions.length === 0 || tableImported) continue;
    low = Math.min(low, base);
    high = Math.max(high, base + functions.length);
  }
  if (high - low > WASM_MODULE_LIMITS.tableSlots)
    throw new WasmModuleFailure(
      "limit",
      `element segments span ${high - low} table slots, above ${WASM_MODULE_LIMITS.tableSlots}`,
      { name: "tableSlots", unit: "entries" },
    );
  const words = new Uint32Array(high > low ? high - low : 0).fill(EMPTY_SLOT);
  for (const { base, functions } of elements) {
    for (let slot = 0; slot < functions.length; slot++) {
      const index = functions[slot]!;
      // The function and import sections state the count; a slot past it is damage.
      if (index >= functionCount)
        throw malformed(
          `table slot ${base + slot} names function ${index}, but the module has ${functionCount}`,
        );
      if (!tableImported) words[base + slot - low] = index;
      if (tick()) yield;
    }
  }

  // Instantiation traps when a segment ends past the initial memory. An
  // imported memory may be larger than its declared minimum, so only a
  // defined one is judged here; the caller refuses imported memories.
  const limit =
    ((memory as WasmMemory | null)?.initialPages ?? 0) * WASM_PAGE_BYTES;
  const memoryImported = (memory as WasmMemory | null)?.imported === true;
  for (const segment of memoryImported ? [] : dataSegments) {
    const end = segment.offset + segment.bytes.length;
    if (end > limit)
      throw malformed(
        `data segment at ${segment.offset} ends at ${end}, past the initial memory of ${limit} bytes`,
      );
  }

  return {
    importedFunctionCount,
    functionCount,
    memory,
    table: new DenseWasmTable(high > low ? low : 0, words),
    tableImported,
    dataSegments,
  };
}

/** Read the whole image at once; callers that can yield use readWasmModuleImageSteps. */
export const readWasmModuleImage = (bytes: Buffer): WasmModuleImage => {
  const steps = readWasmModuleImageSteps(bytes);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

/**
 * Copy active data segments into one buffer spanning the lowest start to the
 * highest end. Later segments overwrite earlier ones, as instantiation does;
 * bytes no segment covers are zero.
 */
export function* readInitialLinearMemorySteps(
  image: Pick<WasmModuleImage, "dataSegments"> &
    Partial<Pick<WasmModuleImage, "memory">>,
  /** Bytes the caller already holds for this module; they count against the same allowance. */
  sourceBytes = 0,
): Generator<void, WasmInitialLinearMemory> {
  const filled = image.dataSegments.filter((s) => s.bytes.length > 0);
  if (filled.length === 0) return { address: 0, bytes: Buffer.alloc(0) };
  let low = Infinity;
  let high = 0;
  for (const s of filled) {
    low = Math.min(low, s.offset);
    high = Math.max(high, s.offset + s.bytes.length);
  }
  // With the memory known, a short zero tail lets a value that straddles the
  // last segment's end read whole; the rest of the initial memory stays out
  // of the view so searches do not walk the unused heap.
  if (image.memory)
    high = Math.max(
      high,
      Math.min(
        // Ending on an 8-byte boundary keeps the zero fill that follows from
        // splitting a pointer slot or an array of them.
        Math.ceil((high + LINEAR_MEMORY_TAIL_BYTES) / 8) * 8,
        image.memory.initialPages * WASM_PAGE_BYTES,
      ),
    );
  // The source module stays live while the view exists, so both count.
  if (high - low + sourceBytes > WASM_MODULE_LIMITS.linearMemoryBytes)
    throw new WasmModuleFailure(
      "limit",
      `data segments span ${high - low} bytes beside a ${sourceBytes}-byte module, above ${WASM_MODULE_LIMITS.linearMemoryBytes} together`,
      { name: "linearMemoryBytes", unit: "bytes" },
    );
  // Sparse segments would make a small file allocate (and searches walk) a
  // large zero span, so the zero bytes the view adds are bounded too.
  // Overlapping segments cover their union once, so count that, not their sum.
  let stored = 0;
  let reach = -1;
  for (const s of [...filled].sort((a, b) => a.offset - b.offset)) {
    const start = Math.max(s.offset, reach);
    const end = s.offset + s.bytes.length;
    if (end > start) stored += end - start;
    reach = Math.max(reach, end);
  }
  if (high - low - stored > WASM_MODULE_LIMITS.linearMemoryGapBytes)
    throw new WasmModuleFailure(
      "limit",
      `data segments leave ${high - low - stored} zero bytes in their span, above ${WASM_MODULE_LIMITS.linearMemoryGapBytes}`,
      { name: "linearMemoryGapBytes", unit: "bytes" },
    );
  // Zero the view in bounded chunks too, so allocation does not block cancellation.
  const memory = Buffer.allocUnsafe(high - low);
  for (let at = 0; at < memory.length; at += LINEAR_MEMORY_COPY_BYTES) {
    memory.fill(0, at, Math.min(at + LINEAR_MEMORY_COPY_BYTES, memory.length));
    yield;
  }
  // Copy in bounded chunks so one large segment does not block cancellation.
  for (const s of filled)
    for (let at = 0; at < s.bytes.length; at += LINEAR_MEMORY_COPY_BYTES) {
      s.bytes.copy(
        memory,
        s.offset - low + at,
        at,
        Math.min(at + LINEAR_MEMORY_COPY_BYTES, s.bytes.length),
      );
      yield;
    }
  return { address: low, bytes: memory };
}

/** The whole view at once; callers that can yield use readInitialLinearMemorySteps. */
export const readInitialLinearMemory = (
  image: Pick<WasmModuleImage, "dataSegments"> &
    Partial<Pick<WasmModuleImage, "memory">>,
  sourceBytes = 0,
): WasmInitialLinearMemory => {
  const steps = readInitialLinearMemorySteps(image, sourceBytes);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};
