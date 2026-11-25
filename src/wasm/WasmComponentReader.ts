import { Budget } from "../domain/budget.js";
import {
  readLeb128,
  SLEB64,
  ULEB32,
  ULEB64,
  type Leb128Encoding,
} from "../domain/leb128.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "../domain/parseFailure.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";

/** The ParseFailure format of WebAssembly component binaries. */
export const WASM_COMPONENT_FORMAT = "wasm-component";

/**
 * Structural failure at an absolute file offset. `malformed` breaks the
 * pinned grammar's framing; `unsupported` is a well-framed construct the
 * decoder does not decode.
 */
export type WasmComponentFormatFailure =
  | ParseFailureError<"malformed">
  | ParseFailureError<"unsupported">;

/** The bytes at `offset` break the pinned grammar's framing. */
export const malformedComponent = (
  offset: number,
  message: string,
  cause?: unknown,
): WasmComponentFormatFailure =>
  malformedInput(
    WASM_COMPONENT_FORMAT,
    `${message} at offset ${String(offset)}`,
    { offset, cause },
  );

/** Names the header field that identifies a selected core module. */
export const CORE_MODULE_FIELD = "layer";

/** The bytes at `offset` are well framed but outside the decoder's coverage. */
export const unsupportedComponent = (
  offset: number,
  message: string,
  field?: string,
): WasmComponentFormatFailure =>
  unsupportedInput(
    WASM_COMPONENT_FORMAT,
    `${message} at offset ${String(offset)}`,
    { offset, ...(field === undefined ? {} : { field }) },
  );

/** A structural failure of this decoder, as opposed to a limit or any other cause. */
export const isWasmComponentFormatFailure = (
  cause: unknown,
): cause is WasmComponentFormatFailure =>
  cause instanceof ParseFailureError &&
  cause.failure.format === WASM_COMPONENT_FORMAT &&
  (cause.failure.kind === "malformed" || cause.failure.kind === "unsupported");

/** Complete component results are returned inline, within this many UTF-8 bytes. */
export const MAX_INLINE_RESULT_BYTES = 8 * 1024 * 1024;

/** A decode-wide resource limit was reached before its facts were built. */
export const componentLimit = (
  name: "decoded-items" | "output-bytes",
  maximum: number,
): ParseFailureError<"limit"> =>
  decodeLimit(
    WASM_COMPONENT_FORMAT,
    name === "decoded-items"
      ? `Decoded entries exceed ${String(maximum)}, so the complete result would exceed the inline output budget; no partial success is returned`
      : `Decoded component facts exceed the ${String(maximum)}-byte inline output budget; no partial success is returned`,
    { name, maximum },
  );

/**
 * Every decoded vector entry and section becomes at least one reported fact,
 * and each serializes to more than 16 bytes, so more than this many could
 * not fit the inline result anyway.
 */
export const MAX_DECODED_ITEMS = MAX_INLINE_RESULT_BYTES / 16;

/** Entries one decode may still create, shared by every reader it uses. */
export class DecodeItemBudget {
  readonly #items = new Budget(MAX_DECODED_ITEMS);

  /** Reserve entries before decoding them. */
  take(count: number): void {
    this.#items.charge(count, () =>
      componentLimit("decoded-items", MAX_DECODED_ITEMS),
    );
  }
}

/** Bounded cursor over one byte range; every offset is an absolute file offset. */
export class WasmComponentReader {
  #offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
    readonly budget: DecodeItemBudget,
  ) {
    this.#offset = start;
  }

  get offset(): number {
    return this.#offset;
  }

  get atEnd(): boolean {
    return this.#offset >= this.end;
  }

  malformed(message: string, at = this.#offset): WasmComponentFormatFailure {
    return malformedComponent(at, message);
  }

  unsupported(message: string, at = this.#offset): WasmComponentFormatFailure {
    return unsupportedComponent(at, message);
  }

  byte(context: string): number {
    if (this.#offset >= this.end)
      throw this.malformed(`Unexpected end of ${context}`);
    const value = this.bytes[this.#offset];
    if (value === undefined)
      throw this.malformed(`Unexpected end of ${context}`);
    this.#offset += 1;
    return value;
  }

  /** The next byte without consuming it, or undefined at the end. */
  peek(): number | undefined {
    return this.#offset < this.end ? this.bytes[this.#offset] : undefined;
  }

  /** Unsigned LEB128 limited to 32 bits, as in core WebAssembly. */
  u32(context: string): number {
    return Number(this.#leb128("u32", ULEB32, context));
  }

  /** Unsigned LEB128 limited to 64 bits; values above 2^53 are not decoded. */
  u64(context: string): number {
    const start = this.#offset;
    const value = this.#leb128("u64", ULEB64, context);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw this.unsupported(
        `${context} exceeds 2^53 and is not decoded`,
        start,
      );
    return Number(value);
  }

  /**
   * Signed 33-bit LEB128 used by core heap types: at most five bytes whose
   * unused high bits repeat the sign.
   */
  s33(context: string): number {
    const start = this.#offset;
    const value = this.#leb128("s33", SLEB64, context);
    if (this.#offset - start > 5 || value < -(2n ** 32n) || value >= 2n ** 32n)
      throw this.malformed(`Invalid s33 LEB128 in ${context}`, start);
    return Number(value);
  }

  #leb128(type: string, encoding: Leb128Encoding, context: string): bigint {
    const start = this.#offset;
    const read = readLeb128(this.bytes, start, this.end, encoding);
    if ("failure" in read)
      throw read.failure === "truncated"
        ? this.malformed(`Unexpected end of ${context}`, read.at)
        : this.malformed(`Invalid ${type} LEB128 in ${context}`, start);
    this.#offset = read.next;
    return read.value;
  }

  /** Length-prefixed UTF-8 text, as `core:name`. */
  name(context: string): string {
    const length = this.u32(`${context} length`);
    const { start, end } = this.range(length, context);
    try {
      // Names are length-prefixed bytes, so a leading U+FEFF is content.
      return decodeStrictUtf8(this.bytes.subarray(start, end), "preserve");
    } catch (cause: unknown) {
      throw malformedComponent(start, `Invalid UTF-8 in ${context}`, cause);
    }
  }

  /** Consume `length` bytes and return their absolute range. */
  range(length: number, context: string): { start: number; end: number } {
    const start = this.#offset;
    if (length > this.end - start)
      throw this.malformed(`${context} extends past its enclosing range`);
    this.#offset += length;
    return { start, end: this.#offset };
  }

  /** Reader limited to the next `length` bytes, which this reader skips. */
  sub(length: number, context: string): WasmComponentReader {
    const { start, end } = this.range(length, context);
    return new WasmComponentReader(this.bytes, start, end, this.budget);
  }

  /** Vector length bounded by the bytes that could encode its elements. */
  count(context: string): number {
    const at = this.#offset;
    const count = this.u32(`${context} count`);
    if (count > this.end - this.#offset)
      throw this.malformed(`${context} count exceeds its remaining bytes`, at);
    this.budget.take(count);
    return count;
  }

  expectEnd(context: string): void {
    if (this.#offset !== this.end)
      throw this.malformed(`Unexpected trailing bytes in ${context}`);
  }
}
