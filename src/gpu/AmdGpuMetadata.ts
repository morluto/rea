import { decode } from "@msgpack/msgpack";
import {
  BinaryResourceFailure,
  BinaryFormatFailure,
} from "../native/metadata/BinaryContainer.js";
import { rejectGpu } from "./GpuSource.js";

export const AMD_METADATA_BYTES = 8 * 1024 * 1024;
const AMD_METADATA_DEPTH = 32;
const AMD_METADATA_VALUES = 262144;
const AMD_METADATA_CONTAINER_ENTRIES = 65536;
const AMD_METADATA_VALUE_BYTES = 65536;

/** Validate allocation and nesting costs before the standard decoder allocates containers. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const preflight = (bytes: Buffer): Set<string> => {
  const strings = new Set<string>();
  let at = 0,
    values = 0;
  const take = (size: number): number => {
    const start = at;
    if (size > bytes.length - at)
      rejectGpu("Truncated AMDGPU MessagePack metadata");
    at += size;
    return start;
  };
  const value = (depth: number): string | undefined => {
    if (depth > AMD_METADATA_DEPTH || ++values > AMD_METADATA_VALUES)
      throw new BinaryResourceFailure(
        "structure",
        AMD_METADATA_VALUES,
        `AMDGPU metadata exceeds depth ${String(AMD_METADATA_DEPTH)} or ${String(AMD_METADATA_VALUES)} decoded values`,
      );
    const code = bytes[take(1)]!;
    const string =
      (code & 0xe0) === 0xa0 || code === 0xd9 || code === 0xda || code === 0xdb;
    const map = (code & 0xf0) === 0x80 || code === 0xde || code === 0xdf;
    let count = 0,
      payload = 0;
    if (
      code <= 0x7f ||
      code >= 0xe0 ||
      code === 0xc0 ||
      code === 0xc2 ||
      code === 0xc3
    )
      return;
    if ((code & 0xe0) === 0xa0) payload = code & 31;
    else if ((code & 0xf0) === 0x90) count = code & 15;
    else if ((code & 0xf0) === 0x80) count = (code & 15) * 2;
    else if (code === 0xdc || code === 0xde)
      count = bytes.readUInt16BE(take(2)) * (code === 0xde ? 2 : 1);
    else if (code === 0xdd || code === 0xdf)
      count = bytes.readUInt32BE(take(4)) * (code === 0xdf ? 2 : 1);
    else if (code === 0xd9 || code === 0xc4) payload = bytes[take(1)]!;
    else if (code === 0xda || code === 0xc5)
      payload = bytes.readUInt16BE(take(2));
    else if (code === 0xdb || code === 0xc6)
      payload = bytes.readUInt32BE(take(4));
    else {
      const widths: Readonly<Record<number, number>> = {
        0xca: 4,
        0xcb: 8,
        0xcc: 1,
        0xcd: 2,
        0xce: 4,
        0xcf: 8,
        0xd0: 1,
        0xd1: 2,
        0xd2: 4,
        0xd3: 8,
      };
      const width = widths[code];
      if (width === undefined) {
        if ([0xc7, 0xc8, 0xc9, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8].includes(code))
          throw new BinaryFormatFailure(
            "unsupported",
            "AMDGPU MessagePack extensions are outside metadata coverage",
          );
        rejectGpu("Reserved AMDGPU MessagePack token");
      }
      payload = width!;
    }
    const start = take(payload);
    // Every declared child requires at least one encoded byte, regardless of
    // its type. Impossible extents are malformed independently of limits.
    if (count > bytes.length - at)
      rejectGpu("Truncated AMDGPU MessagePack metadata container");
    if ((map ? count / 2 : count) > AMD_METADATA_CONTAINER_ENTRIES)
      throw new BinaryResourceFailure(
        "structure",
        AMD_METADATA_CONTAINER_ENTRIES,
        `AMDGPU metadata container exceeds its ${String(AMD_METADATA_CONTAINER_ENTRIES)}-entry allocation budget`,
      );
    if (payload > AMD_METADATA_VALUE_BYTES)
      throw new BinaryResourceFailure(
        "structure",
        AMD_METADATA_VALUE_BYTES,
        `AMDGPU metadata value exceeds its ${String(AMD_METADATA_VALUE_BYTES)}-byte allocation budget`,
      );
    if (count > AMD_METADATA_VALUES - values)
      throw new BinaryResourceFailure(
        "structure",
        AMD_METADATA_VALUES,
        "AMDGPU metadata container exceeds its aggregate value budget",
      );
    if (string) {
      strings.add(`${bytes.byteOffset + start}:${payload}`);
      try {
        return utf8.decode(bytes.subarray(start, start + payload));
      } catch {
        return rejectGpu("AMDGPU metadata contains invalid UTF-8");
      }
    }
    if (map) {
      const keys = new Set<string>();
      for (let index = 0; index < count; index += 2) {
        const key = value(depth + 1);
        if (key === undefined || keys.has(key))
          rejectGpu("AMDGPU metadata map has non-string or duplicate keys");
        keys.add(key!);
        value(depth + 1);
      }
    } else for (let index = 0; index < count; index++) value(depth + 1);
    return undefined;
  };
  value(0);
  if (at !== bytes.length) rejectGpu("Trailing AMDGPU MessagePack values");
  return strings;
};
export const readAmdMetadata = (bytes: Buffer): unknown => {
  if (bytes.length > AMD_METADATA_BYTES)
    throw new BinaryResourceFailure(
      "structure",
      AMD_METADATA_BYTES,
      "AMDGPU metadata exceeds 8 MiB",
    );
  const strings = preflight(bytes);
  const stringValue = (value: unknown): string => {
    if (
      !(value instanceof Uint8Array) ||
      value.buffer !== bytes.buffer ||
      !strings.has(`${value.byteOffset}:${value.byteLength}`)
    )
      return rejectGpu("AMDGPU metadata map key is not a string");
    return utf8.decode(value);
  };
  // rawStrings avoids the standard decoder's native UTF-8 path stripping a
  // leading BOM. The preflight retains original type tags, so binary values
  // cannot accidentally become strings during this bounded in-place walk.
  const normalize = (value: unknown): unknown => {
    if (value instanceof Uint8Array)
      return value.buffer === bytes.buffer &&
        strings.has(`${value.byteOffset}:${value.byteLength}`)
        ? stringValue(value)
        : value;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++)
        value[index] = normalize(value[index]);
    } else if (value !== null && typeof value === "object")
      for (const key of Object.keys(value)) {
        const record = value as Record<string, unknown>;
        record[key] = normalize(record[key]);
      }
    return value;
  };
  try {
    return normalize(
      decode(bytes, {
        rawStrings: true,
        keyDecoder: {
          canBeCached: () => true,
          decode: (source, offset, length) =>
            utf8.decode(source.subarray(offset, offset + length)),
        },
        mapKeyConverter: (key) => {
          if (typeof key !== "string")
            return rejectGpu("AMDGPU metadata map key is not a string");
          return key;
        },
        useBigInt64: true,
        maxStrLength: AMD_METADATA_VALUE_BYTES,
        maxBinLength: AMD_METADATA_VALUE_BYTES,
        maxArrayLength: AMD_METADATA_CONTAINER_ENTRIES,
        maxMapLength: AMD_METADATA_CONTAINER_ENTRIES,
        maxExtLength: 0,
      }),
    );
  } catch {
    return rejectGpu("Malformed AMDGPU MessagePack metadata");
  }
};
export const amdRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export const amdCount = (value: unknown): number | null => {
  if (typeof value === "bigint")
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};
export const amdString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
