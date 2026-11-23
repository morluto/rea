import { isUtf8 } from "node:buffer";
import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import { readLeb128, ULEB32 } from "../domain/leb128.js";
import type { NativeByteSource } from "../domain/native/nativeSectionDirectory.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../domain/parseFailure.js";

/** The ParseFailure format of WebAssembly section framing. */
export const WASM_FORMAT = "wasm";

/**
 * Producer output holds a few dozen sections. The format sets no bound, and a
 * 256 MiB input of three-byte custom sections would otherwise keep this
 * synchronous walk busy for about 89 million sections.
 */
export const MAX_WASM_SECTIONS = 65_536;
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

/**
 * Walk the section framing of one WebAssembly core module without validating,
 * instantiating or executing it. Components embed several core modules and no
 * input selects one, so they are refused.
 */
export const readRustWasmSections = (bytes: Buffer): RustWasmSections => {
  if (bytes.length < 8)
    throw truncatedInput(WASM_FORMAT, "WebAssembly header is truncated", {
      offset: 0,
    });
  if (bytes.subarray(6, 8).equals(COMPONENT_LAYER))
    throw unsupportedInput(
      WASM_FORMAT,
      "WebAssembly components are unsupported; their embedded core modules are not inspected",
      { offset: 6, field: "layer" },
    );
  if (!bytes.subarray(4, 8).equals(CORE_MODULE_VERSION))
    throw unsupportedInput(
      WASM_FORMAT,
      "Only version 1 WebAssembly core modules are supported",
      { offset: 4, field: "version" },
    );
  const dependencies: WasmSectionRange[] = [];
  let data: WasmSectionRange | null = null;
  let cursor = 8;
  for (let sections = 0; cursor < bytes.length; sections += 1) {
    const id = bytes[cursor]!;
    const size = readU32(bytes, cursor + 1, bytes.length, {
      label: "section size",
      boundary: "file",
    });
    const end = size.end + size.value;
    if (end > bytes.length)
      throw truncatedInput(
        WASM_FORMAT,
        "WebAssembly section extends past the end of the file",
        { offset: cursor, field: "section" },
      );
    // Admit one complete frame before charging any section payload work.
    if (sections === MAX_WASM_SECTIONS)
      throw decodeLimit(
        WASM_FORMAT,
        `WebAssembly module declares more than ${MAX_WASM_SECTIONS} sections`,
        { name: "max_wasm_sections", maximum: MAX_WASM_SECTIONS },
        { offset: cursor },
      );
    if (id === CUSTOM_SECTION) {
      const custom = customSection(bytes, size.end, end);
      if (custom.name.equals(DEPENDENCY_SECTION)) {
        dependencies.push({
          offset: custom.payload,
          size: end - custom.payload,
        });
        // A second match establishes the duplicate. Walking on could only
        // replace that failure with a later one, such as the section bound.
        if (dependencies.length === 2) break;
      }
    } else if (id === DATA_SECTION) {
      if (data !== null)
        throw malformedInput(
          WASM_FORMAT,
          "WebAssembly module declares more than one data section",
          { offset: cursor, field: "data section" },
        );
      data = { offset: size.end, size: size.value };
    }
    cursor = end;
  }
  return { dependency_sections: dependencies, data_section: data };
};

const WASM_SECTION_HEADER_PROBE_BYTES = 16;
const WASM_YIELD_INTERVAL = 256;

/** Stream WebAssembly core-module section framing over a range reader. */
export const readRustWasmSectionsFromReader = async (
  source: NativeByteSource,
  pause?: ZstandardFramePause,
): Promise<RustWasmSections> => {
  const readSlice = (offset: number, length: number): Promise<Buffer> => {
    if (length <= 0 || offset >= source.size)
      return Promise.resolve(Buffer.alloc(0));
    const clamped = Math.min(length, source.size - offset);
    if (source.prefix !== undefined && offset + clamped <= source.prefix.length)
      return Promise.resolve(source.prefix.subarray(offset, offset + clamped));
    return source.readRange(offset, clamped);
  };
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
    if (sections === MAX_WASM_SECTIONS)
      throw decodeLimit(
        WASM_FORMAT,
        `WebAssembly module declares more than ${MAX_WASM_SECTIONS} sections`,
        { name: "max_wasm_sections", maximum: MAX_WASM_SECTIONS },
        { offset: cursor },
      );
    if (id === CUSTOM_SECTION) {
      const nameHeaderLen = Math.min(5, end - payloadStart);
      const nameHeader = await readSlice(payloadStart, nameHeaderLen);
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
      const name = await readSlice(nameStart, nameLen.value);
      if (!isUtf8(name))
        throw malformedInput(
          WASM_FORMAT,
          "WebAssembly custom section name is not valid UTF-8",
          { offset: nameStart, field: "custom section name" },
        );
      const payload = nameStart + nameLen.value;
      if (name.equals(DEPENDENCY_SECTION)) {
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

/** Decode a custom section's UTF-8 name and locate the payload that follows it. */
const customSection = (
  bytes: Buffer,
  start: number,
  end: number,
): { readonly name: Buffer; readonly payload: number } => {
  const length = readU32(bytes, start, end, {
    label: "custom section name length",
    boundary: "section",
  });
  if (length.value > end - length.end)
    throw malformedInput(
      WASM_FORMAT,
      "WebAssembly custom section name extends past its section",
      { offset: start, field: "custom section name" },
    );
  const payload = length.end + length.value;
  const name = bytes.subarray(length.end, payload);
  if (!isUtf8(name))
    throw malformedInput(
      WASM_FORMAT,
      "WebAssembly custom section name is not valid UTF-8",
      { offset: length.end, field: "custom section name" },
    );
  return { name, payload };
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
    baseOffset = 0,
  }: {
    readonly label: string;
    readonly boundary: "file" | "section";
    readonly baseOffset?: number;
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
