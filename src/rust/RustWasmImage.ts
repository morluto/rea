import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import { readLeb128, ULEB32 } from "../domain/leb128.js";
import { isStrictUtf8, strictUtf8Decoder } from "../domain/strictUtf8.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../domain/parseFailure.js";
import { readByteSourceSlice, type ByteSource } from "../domain/byteSource.js";
import { RUST_WASM_SECTION_BUDGET } from "../domain/rust/rustBinary.js";

/** The ParseFailure format of WebAssembly section framing. */
export const WASM_FORMAT = "wasm";

const PREAMBLE = Buffer.from("\0asm", "latin1");
const CORE_MODULE_VERSION = Buffer.from([1, 0, 0, 0]);
const COMPONENT_LAYER = Buffer.from([1, 0]);
const CUSTOM_SECTION = 0;
const DATA_SECTION = 11;
const DEPENDENCY_SECTION = Buffer.from(".dep-v0", "latin1");

/** One exact file range inside the selected WebAssembly module. */
export interface WasmSectionRange {
  readonly offset: number;
  readonly size: number;
}

/** Section ranges that Rust metadata lookups read from one core module. */
export interface RustWasmSections {
  /**
   * `.dep-v0` custom-section payloads. Two establish a duplicate, and the walk
   * ends there, so later sections are not examined.
   */
  readonly dependency_sections: readonly WasmSectionRange[];
  /** The module's data section, where rustc stores constant path strings. */
  readonly data_section: WasmSectionRange | null;
}

/** Every WebAssembly binary layer, module or component, opens with `\0asm`. */
export const hasWasmPreamble = (bytes: Buffer): boolean =>
  bytes.subarray(0, PREAMBLE.length).equals(PREAMBLE);

const WASM_SECTION_HEADER_PROBE_BYTES = 16;
const WASM_YIELD_INTERVAL = 256;

/** Stream WebAssembly core-module section framing over a range reader. */
export const readRustWasmSectionsFromReader = async (
  source: ByteSource,
  pause?: ZstandardFramePause,
  /**
   * Producer output holds a few dozen sections. The format sets no bound, and
   * a 256 MiB input of three-byte custom sections would otherwise keep this
   * walk busy for about 89 million sections.
   */
  maxSections: number = RUST_WASM_SECTION_BUDGET.default_value,
): Promise<RustWasmSections> => {
  const readSlice = (offset: number, length: number) =>
    readByteSourceSlice(source, offset, length);
  if (source.size < 8)
    throw truncatedInput(WASM_FORMAT, "WebAssembly header is truncated", {
      offset: 0,
    });
  const header = await readSlice(0, 8);
  if (header.subarray(6, 8).equals(COMPONENT_LAYER))
    throw unsupportedInput(
      WASM_FORMAT,
      "WebAssembly components are unsupported; their embedded core modules are not inspected",
      { offset: 6, field: "layer" },
    );
  if (!header.subarray(4, 8).equals(CORE_MODULE_VERSION))
    throw unsupportedInput(
      WASM_FORMAT,
      "Only version 1 WebAssembly core modules are supported",
      { offset: 4, field: "version" },
    );
  const dependencies: WasmSectionRange[] = [];
  let data: WasmSectionRange | null = null;
  let cursor = 8;
  for (let sections = 0; cursor < source.size; sections += 1) {
    if (
      pause !== undefined &&
      sections > 0 &&
      sections % WASM_YIELD_INTERVAL === 0
    )
      await pause();
    const probe = await readSlice(cursor, WASM_SECTION_HEADER_PROBE_BYTES);
    const id = probe[0]!;
    const size = readU32(probe, 1, probe.length, {
      label: "section size",
      boundary: "file",
      baseOffset: cursor,
    });
    const payloadStart = cursor + size.end;
    const end = payloadStart + size.value;
    if (end > source.size)
      throw truncatedInput(
        WASM_FORMAT,
        "WebAssembly section extends past the end of the file",
        { offset: cursor, field: "section" },
      );
    // Admit one complete frame before charging any section payload work.
    // Sections are walked in turn, so the complete count is unknown here.
    if (sections === maxSections)
      throw decodeLimit(
        WASM_FORMAT,
        `WebAssembly module declares more than max_wasm_sections (${String(maxSections)}) sections`,
        { name: "max_wasm_sections", maximum: maxSections },
        { offset: cursor },
      );
    if (id === CUSTOM_SECTION) {
      // A name length cannot consume bytes from the next section.
      const nameHeaderLen = Math.min(5, end - payloadStart);
      const nameHeaderEnd = size.end + nameHeaderLen;
      const nameHeader =
        nameHeaderEnd <= probe.length
          ? probe.subarray(size.end, nameHeaderEnd)
          : await readSlice(payloadStart, nameHeaderLen);
      const nameLen = readU32(nameHeader, 0, nameHeader.length, {
        label: "custom section name length",
        boundary: "section",
        baseOffset: payloadStart,
      });
      const nameStart = payloadStart + nameLen.end;
      if (nameLen.value > end - nameStart)
        throw malformedInput(
          WASM_FORMAT,
          "WebAssembly custom section name extends past its section",
          { offset: payloadStart, field: "custom section name" },
        );
      const matches = await isDependencyName(
        readSlice,
        nameStart,
        nameLen.value,
        pause,
      );
      const payload = nameStart + nameLen.value;
      if (matches) {
        dependencies.push({ offset: payload, size: end - payload });
        if (dependencies.length === 2) break;
      }
    } else if (id === DATA_SECTION) {
      if (data !== null)
        throw malformedInput(
          WASM_FORMAT,
          "WebAssembly module declares more than one data section",
          { offset: cursor, field: "data section" },
        );
      data = { offset: payloadStart, size: size.value };
    }
    cursor = end;
  }
  return { dependency_sections: dependencies, data_section: data };
};

const WASM_NAME_CHUNK_BYTES = 64 * 1024;

const invalidNameUtf8 = (offset: number) =>
  malformedInput(
    WASM_FORMAT,
    "WebAssembly custom section name is not valid UTF-8",
    {
      offset,
      field: "custom section name",
    },
  );

/** Validate opaque names without retaining their text or losing a split code point. */
const isDependencyName = async (
  readRange: (offset: number, length: number) => Promise<Buffer>,
  offset: number,
  size: number,
  pause: ZstandardFramePause | undefined,
): Promise<boolean> => {
  if (size <= WASM_NAME_CHUNK_BYTES) {
    const bytes = await readRange(offset, size);
    if (bytes.length !== size)
      throw truncatedInput(
        WASM_FORMAT,
        "WebAssembly custom section name read ended early",
        { offset, field: "custom section name" },
      );
    if (!isStrictUtf8(bytes)) throw invalidNameUtf8(offset);
    return bytes.equals(DEPENDENCY_SECTION);
  }
  const decoder = strictUtf8Decoder("preserve");
  for (let at = 0; at < size; at += WASM_NAME_CHUNK_BYTES) {
    if (at > 0) await pause?.();
    const length = Math.min(WASM_NAME_CHUNK_BYTES, size - at);
    const bytes = await readRange(offset + at, length);
    if (bytes.length !== length)
      throw truncatedInput(
        WASM_FORMAT,
        "WebAssembly custom section name read ended early",
        { offset: offset + at, field: "custom section name" },
      );
    try {
      decoder.decode(bytes, { stream: at + length < size });
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      throw invalidNameUtf8(offset);
    }
  }
  return false;
};

/**
 * Decode one unsigned LEB128 u32 that must end before `end`. An integer the
 * file cuts off is truncated; one its enclosing section cuts off is malformed,
 * wherever that section lies in the file.
 */
const readU32 = (
  bytes: Buffer,
  offset: number,
  end: number,
  {
    label,
    boundary,
    baseOffset,
  }: {
    readonly label: string;
    readonly boundary: "file" | "section";
    readonly baseOffset: number;
  },
): { readonly value: number; readonly end: number } => {
  const read = readLeb128(bytes, offset, end, ULEB32);
  if ("value" in read) return { value: Number(read.value), end: read.next };
  const site = { offset: baseOffset + offset, field: label };
  if (read.failure === "truncated" && boundary === "file")
    throw truncatedInput(
      WASM_FORMAT,
      `WebAssembly ${label} extends past the end of the file`,
      site,
    );
  throw malformedInput(
    WASM_FORMAT,
    read.failure === "truncated"
      ? `WebAssembly ${label} extends past its section`
      : `WebAssembly ${label} does not fit a 32-bit LEB128 integer`,
    site,
  );
};
