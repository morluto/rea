import { createHash } from "node:crypto";
import {
  MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES,
  V8_CODE_CACHE_COMPILE_FUNCTION_BIT,
  V8_CODE_CACHE_HEADER_BYTES,
  V8_CODE_CACHE_MAGIC_HIGH,
  V8_CODE_CACHE_SOURCE_LENGTH_MASK,
  type V8CodeCache,
} from "../domain/v8/v8CodeCache.js";
import type { V8CodeCacheInputBudget } from "../domain/v8/v8CodeCacheBudget.js";
import {
  V8CodeCacheBudgetFailure,
  V8CodeCacheFormatFailure,
} from "../v8/V8CodeCache.errors.js";

const unsupported = (message: string): never => {
  throw new V8CodeCacheFormatFailure("unsupported", message);
};
const malformed = (message: string): never => {
  throw new V8CodeCacheFormatFailure("malformed", message);
};

/**
 * Header word roles. Reproduced from observation against the producing V8, not from an
 * assumed ABI: the container is version-dependent and only the magic high half and the
 * payload-length relation are relied on as admission conditions.
 */
const HEADER_ROLES: ReadonlyArray<{
  role: string;
  status: "confirmed" | "inferred" | "unconfirmed";
}> = [
  { role: "magic", status: "confirmed" },
  { role: "version_hash", status: "inferred" },
  { role: "source_length", status: "confirmed" },
  { role: "flag_hash", status: "inferred" },
  { role: "build_constant", status: "inferred" },
  { role: "payload_length", status: "confirmed" },
  { role: "reserved", status: "unconfirmed" },
  { role: "reserved", status: "unconfirmed" },
];

const LIMITATIONS = [
  "The payload is serialized V8 heap data, not source. No logic is recovered and no bytecode is decompiled.",
  "Recovering logic requires a version-pinned V8 decompiler (View8-style) that this tool neither installs nor runs.",
  "Embedded strings are byte-pattern observations inside the payload, not parsed heap objects: a reported sequence is not proof V8 retained it as a string, and a missing literal is not proof it is absent.",
  "Header field roles beyond magic, source length, and payload length are inferred from one producer and are version-dependent; treat them as observations, not a fixed ABI.",
];

/** Printable ASCII and horizontal tab, the run alphabet of one observation. */
const isPrintable = (byte: number): boolean =>
  (byte >= 0x20 && byte <= 0x7e) || byte === 0x09;

const payloadSha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Read one V8 code cache container without executing it.
 *
 * Admission is deliberately narrow: the header size this reader pins, the V8 code cache
 * magic high half, and payload length reaching exactly the end of the file. Everything
 * else is reported as an observation so a producer this reader has never seen still
 * yields its facts instead of a false parse.
 */
export const parseV8CodeCache = (
  bytes: Buffer,
  artifact: { path: string; sha256: string; bytes: number },
  input: V8CodeCacheInputBudget,
): V8CodeCache => {
  if (bytes.length !== artifact.bytes)
    malformed("Selected artifact length disagrees with the retained bytes.");
  if (bytes.length < V8_CODE_CACHE_HEADER_BYTES)
    malformed(
      `Selected file is shorter than the ${String(V8_CODE_CACHE_HEADER_BYTES)}-byte V8 code cache header.`,
    );

  const field = (index: number): number => bytes.readUInt32LE(index * 4);
  const magic = field(0);
  const magicHigh = magic >>> 16;
  if (magicHigh !== V8_CODE_CACHE_MAGIC_HIGH)
    unsupported(
      `Container magic 0x${magic.toString(16).padStart(8, "0")} does not carry the V8 code cache high half 0x${V8_CODE_CACHE_MAGIC_HIGH.toString(16)}; this file is not a V8 code cache.`,
    );

  const declaredPayload = field(5);
  const payloadOffset = V8_CODE_CACHE_HEADER_BYTES;
  const expectedPayload = bytes.length - payloadOffset;
  if (declaredPayload !== expectedPayload)
    malformed(
      `Header declares a ${String(declaredPayload)}-byte payload but ${String(expectedPayload)} bytes follow the ${String(V8_CODE_CACHE_HEADER_BYTES)}-byte header; the container is truncated or corrupt.`,
    );

  const sourceWord = field(2);
  const sourceLength = sourceWord & V8_CODE_CACHE_SOURCE_LENGTH_MASK;
  const producer =
    (sourceWord & V8_CODE_CACHE_COMPILE_FUNCTION_BIT) !== 0
      ? ("compile_function" as const)
      : ("script" as const);

  const payload = bytes.subarray(payloadOffset);
  const observations: V8CodeCache["embedded_strings"] = [];
  let runStart = -1;
  const flush = (end: number): void => {
    if (runStart < 0) return;
    const runBytes = end - runStart;
    if (runBytes >= input.min_string_bytes) {
      if (observations.length >= input.max_strings)
        throw new V8CodeCacheBudgetFailure(
          "max_strings",
          input.max_strings,
          `Payload contains more than ${String(input.max_strings)} printable runs of at least ${String(input.min_string_bytes)} bytes; raise max_strings or raise min_string_bytes.`,
        );
      const retained = Math.min(
        runBytes,
        MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES,
      );
      const absolute = payloadOffset + runStart;
      observations.push({
        offset: absolute,
        bytes: runBytes,
        retained_bytes: retained,
        truncated: retained < runBytes,
        text: payload
          .subarray(runStart, runStart + retained)
          .toString("latin1"),
      });
    }
    runStart = -1;
  };
  for (const [index, byte] of payload.entries()) {
    if (isPrintable(byte)) {
      if (runStart < 0) runStart = index;
    } else {
      flush(index);
    }
  }
  flush(payload.length);

  return {
    artifact,
    header: {
      magic,
      magic_build_stable: magicHigh,
      fields: HEADER_ROLES.map((entry, index) => ({
        offset: index * 4,
        value: field(index),
        role: entry.role,
        status: entry.status,
      })),
      header_bytes: V8_CODE_CACHE_HEADER_BYTES,
      source_length: sourceLength,
      producer,
    },
    payload: {
      offset: payloadOffset,
      bytes: payload.length,
      sha256: payloadSha256(payload),
      trailing_bytes: 0,
    },
    embedded_strings: observations,
    coverage: {
      status: "complete",
      scanned_bytes: payload.length,
      strings: observations.length,
    },
    limitations: LIMITATIONS,
  };
};
