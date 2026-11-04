import { isUtf8 } from "node:buffer";
import {
  RustAuditableFormatFailure,
  RustAuditableResourceFailure,
} from "./RustAuditableReader.js";

/**
 * Producer output holds a few dozen sections. The format sets no bound, and a
 * 256 MiB input of three-byte custom sections would otherwise keep this
 * synchronous walk busy for about 89 million sections.
 */
export const MAX_WASM_SECTIONS = 65_536;
const PREAMBLE = Buffer.from("\0asm", "latin1");
const CORE_MODULE_VERSION = Buffer.from([1, 0, 0, 0]);
const COMPONENT_LAYER = 1;
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
  /** `.dep-v0` custom-section payloads; two already establish a duplicate. */
  readonly dependency_sections: readonly WasmSectionRange[];
  /** The module's data section, where rustc stores constant path strings. */
  readonly data_section: WasmSectionRange | null;
}

/** Every WebAssembly binary layer, module or component, opens with `\0asm`. */
export const hasWasmPreamble = (bytes: Buffer): boolean =>
  bytes.subarray(0, PREAMBLE.length).equals(PREAMBLE);

/**
 * Walk the section framing of one WebAssembly core module without validating,
 * instantiating or executing it. Components embed core modules as universal
 * Mach-O files embed slices, so they are refused rather than selecting one.
 */
export const readRustWasmSections = (bytes: Buffer): RustWasmSections => {
  if (bytes.length < 8)
    throw new RustAuditableFormatFailure(
      "malformed",
      "WebAssembly header is truncated",
    );
  if (bytes.readUInt16LE(6) === COMPONENT_LAYER)
    throw new RustAuditableFormatFailure(
      "unsupported",
      "WebAssembly components are unsupported; their embedded core modules are not inspected",
    );
  if (!bytes.subarray(4, 8).equals(CORE_MODULE_VERSION))
    throw new RustAuditableFormatFailure(
      "unsupported",
      "Only version 1 WebAssembly core modules are supported",
    );
  const dependencies: WasmSectionRange[] = [];
  let data: WasmSectionRange | null = null;
  let cursor = 8;
  for (let sections = 0; cursor < bytes.length; sections += 1) {
    if (sections === MAX_WASM_SECTIONS)
      throw new RustAuditableResourceFailure(
        {
          resource: "cpu",
          reported_limits: { maximum_wasm_sections: MAX_WASM_SECTIONS },
        },
        `WebAssembly module declares more than ${MAX_WASM_SECTIONS} sections`,
      );
    const id = bytes[cursor]!;
    const size = readU32(bytes, cursor + 1, bytes.length, "section size");
    const end = size.end + size.value;
    if (end > bytes.length)
      throw new RustAuditableFormatFailure(
        "malformed",
        "WebAssembly section extends past the end of the file",
      );
    if (id === CUSTOM_SECTION) {
      const custom = customSection(bytes, size.end, end);
      // A second match establishes the duplicate; more would only grow memory.
      if (custom.name.equals(DEPENDENCY_SECTION) && dependencies.length < 2)
        dependencies.push({
          offset: custom.payload,
          size: end - custom.payload,
        });
    } else if (id === DATA_SECTION) {
      if (data !== null)
        throw new RustAuditableFormatFailure(
          "malformed",
          "WebAssembly module declares more than one data section",
        );
      data = { offset: size.end, size: size.value };
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
  const length = readU32(bytes, start, end, "custom section name length");
  if (length.value > end - length.end)
    throw new RustAuditableFormatFailure(
      "malformed",
      "WebAssembly custom section name extends past its section",
    );
  const payload = length.end + length.value;
  const name = bytes.subarray(length.end, payload);
  if (!isUtf8(name))
    throw new RustAuditableFormatFailure(
      "malformed",
      "WebAssembly custom section name is not valid UTF-8",
    );
  return { name, payload };
};

/** Decode one unsigned LEB128 u32, which the binary format bounds to five bytes. */
const readU32 = (
  bytes: Buffer,
  offset: number,
  end: number,
  label: string,
): { readonly value: number; readonly end: number } => {
  let value = 0;
  for (let index = 0; index < 5 && offset + index < end; index += 1) {
    const byte = bytes[offset + index]!;
    // The fifth byte may only carry the four remaining bits and no continuation.
    if (index === 4 && byte > 0x0f) break;
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) return { value, end: offset + index + 1 };
  }
  throw new RustAuditableFormatFailure(
    "malformed",
    `WebAssembly ${label} is not a complete 32-bit LEB128 integer`,
  );
};
