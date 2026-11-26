import { createHash } from "node:crypto";
import {
  MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES,
  V8_CODE_CACHE_COMPILE_FUNCTION_BIT,
  V8_CODE_CACHE_LEGACY_MODULE_BIT,
  V8_CODE_CACHE_MODULE_BIT,
  V8_CODE_CACHE_HEADER_BYTES,
  V8_CODE_CACHE_LEGACY_HEADER_BYTES,
  V8_CODE_CACHE_MIN_HEADER_BYTES,
  V8_CODE_CACHE_NARROW_HEADER_BYTES,
  V8_CODE_CACHE_MAGIC_HIGH,
  V8_CODE_CACHE_SOURCE_LENGTH_MASK,
  type V8CodeCache,
} from "../domain/v8/v8CodeCache.js";
import type { V8CodeCacheInputBudget } from "../domain/v8/v8CodeCacheBudget.js";
import { V8_CODE_CACHE_FORMAT } from "./V8CodeCache.errors.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { readAdmittedRange } from "../resources/index.js";
import {
  decodeLimit,
  malformedInput,
  unsupportedInput,
} from "../domain/parseFailure.js";
import type { PrefixedByteSource } from "../domain/byteSource.js";

const unsupported = (message: string): never => {
  throw unsupportedInput(V8_CODE_CACHE_FORMAT, message);
};
const malformed = (message: string): never => {
  throw malformedInput(V8_CODE_CACHE_FORMAT, message);
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

/**
 * Word roles of the six-word header that `code-serializer.h` defines in V8 8.8 through
 * 11.7, which has no read-only snapshot checksum word. No producer of those releases was
 * measured, so only the two facts admission checks on the container itself are confirmed.
 */
const LEGACY_HEADER_ROLES: typeof HEADER_ROLES = [
  { role: "magic", status: "confirmed" },
  { role: "version_hash", status: "inferred" },
  { role: "source_length", status: "inferred" },
  { role: "flag_hash", status: "inferred" },
  { role: "payload_length", status: "confirmed" },
  { role: "reserved", status: "unconfirmed" },
];

const LEGACY_LIMITATION =
  "This container has the six-word header of V8 8.8 through 11.7. That layout is taken from the V8 sources of those releases, not measured against one of their producers, so its source-length role is inferred too.";

const LIMITATIONS = [
  "The payload is serialized V8 heap data, not source. No logic is recovered and no bytecode is decompiled.",
  "Recovering logic requires a version-pinned V8 decompiler (View8-style) that this tool neither installs nor runs.",
  "Embedded strings are byte-pattern observations inside the payload, not parsed heap objects: a reported sequence is not proof V8 retained it as a string, and a missing literal is not proof it is absent.",
  "Header field roles beyond magic, source length, and payload length are inferred from one producer and are version-dependent; treat them as observations, not a fixed ABI.",
  "An unflagged producer word is reported as unknown: whether V8 marks a vm.compileFunction cache at all is a build detail, so the container cannot separate a vm.Script from an unmarked function cache on its own.",
];

/** Bit 30 (V8 13.4+) or bit 31 (earlier V8, including Node 22) marks a module cache. */
const MODULE_BITS = V8_CODE_CACHE_MODULE_BIT | V8_CODE_CACHE_LEGACY_MODULE_BIT;

/** Printable ASCII and horizontal tab, the run alphabet of one observation. */
const isPrintable = (byte: number): boolean =>
  (byte >= 0x20 && byte <= 0x7e) || byte === 0x09;

const STREAM_CHUNK_BYTES = 1024 * 1024;

interface ParsedV8Header {
  readonly header: V8CodeCache["header"];
  readonly payloadOffset: number;
  readonly payloadLength: number;
  readonly sixWords: boolean;
}

const parseV8CodeCacheHeader = (
  headerBytes: Buffer,
  totalBytes: number,
): ParsedV8Header => {
  if (totalBytes < V8_CODE_CACHE_MIN_HEADER_BYTES)
    malformed(
      `Selected file is shorter than the ${String(V8_CODE_CACHE_MIN_HEADER_BYTES)}-byte V8 code cache header.`,
    );

  const headerReader = new BinaryReader(
    headerBytes.subarray(
      0,
      Math.min(headerBytes.length, V8_CODE_CACHE_HEADER_BYTES),
    ),
    true,
    V8_CODE_CACHE_FORMAT,
  );
  const magic = headerReader.u32(0);
  const magicHigh = magic >>> 16;
  if (magicHigh !== V8_CODE_CACHE_MAGIC_HIGH)
    unsupported(
      `Container magic 0x${magic.toString(16).padStart(8, "0")} does not carry the V8 code cache high half 0x${V8_CODE_CACHE_MAGIC_HIGH.toString(16)}; this file is not a V8 code cache.`,
    );

  // Each pinned layout declares the payload length in its own word, and that
  // length must reach the end of the file from one of the layout's header
  // extents. Seven words pad to 28 or 32 bytes; six words are 24 bytes on
  // both pointer widths.
  const declaredPayload = headerReader.u32(0x14);
  const alignedOffset = totalBytes - declaredPayload;
  const sevenWords =
    alignedOffset === V8_CODE_CACHE_NARROW_HEADER_BYTES ||
    alignedOffset === V8_CODE_CACHE_HEADER_BYTES;
  const legacyPayload = headerReader.u32(0x10);
  const legacyOffset = totalBytes - legacyPayload;
  const sixWords = legacyOffset === V8_CODE_CACHE_LEGACY_HEADER_BYTES;
  // The word at 0x10 is a build constant in one layout and the payload length
  // in the other, so a container fits both only by coincidence, and nothing
  // in the header says which reading its producer meant.
  if (sevenWords && sixWords)
    malformed(
      `Both admitted layouts fit this container, so its header is ambiguous: ${String(declaredPayload)} payload bytes after ${String(alignedOffset)} header bytes, or ${String(legacyPayload)} after ${String(legacyOffset)}.`,
    );
  if (!sevenWords && !sixWords)
    malformed(
      `Header declares a ${String(declaredPayload)}-byte payload at 0x14, leaving ${String(alignedOffset)} header bytes where the seven-word layout has ${String(V8_CODE_CACHE_NARROW_HEADER_BYTES)} or ${String(V8_CODE_CACHE_HEADER_BYTES)}, and a ${String(legacyPayload)}-byte payload at 0x10, leaving ${String(legacyOffset)} where the six-word layout has ${String(V8_CODE_CACHE_LEGACY_HEADER_BYTES)}; the container is truncated, corrupt, or written with a header this reader does not admit.`,
    );
  const payloadOffset = sixWords ? legacyOffset : alignedOffset;
  // Node v24.22.1's SerializedCodeData writer in code-serializer.cc zeroes
  // the alignment bytes after its words. A missing final wide payload word
  // and a narrow payload beginning with a zero word are indistinguishable here.
  if (
    payloadOffset === V8_CODE_CACHE_NARROW_HEADER_BYTES &&
    totalBytes >= V8_CODE_CACHE_HEADER_BYTES &&
    headerReader.u32(V8_CODE_CACHE_NARROW_HEADER_BYTES) === 0
  )
    malformed(
      "A 28-byte header extent followed by a zero word is ambiguous: the file may have a zero-leading narrow payload or a truncated 32-byte layout.",
    );

  // The word table covers exactly the header extent this container carries.
  const roles = sixWords ? LEGACY_HEADER_ROLES : HEADER_ROLES;
  const fields = roles.slice(0, payloadOffset / 4).map((entry, index) => {
    const offset = index * 4;
    return { offset, value: headerReader.u32(offset), ...entry };
  });

  const sourceWord = fields[2]!.value;
  const sourceLength = sourceWord & V8_CODE_CACHE_SOURCE_LENGTH_MASK;
  // Bit 30 marks a `vm.SourceTextModule` cache and bit 29 a `vm.compileFunction` one.
  // Measured on Node 24.22.1, a 19-unit module source reads `0x40000013` while a script of
  // the same length reads `0x00000013`, so the function bit alone reports a module cache as
  // a script. Both bits sit outside the source-length mask.
  //
  // The unflagged case is `unknown`, not `script`: whether V8 marks a function cache is a
  // build detail. A `vm.compileFunction` cache reads `0x20000004` on Node 24.22.1 and
  // `0x00000004` on Node 22.23.4 for a 4-unit source, so an unflagged word is either
  // `vm.Script` or an unmarked function cache, and the container carries nothing that
  // separates them. `fields` keeps the observed word so a caller can resolve it against a
  // build fingerprint it trusts.
  const producer =
    (sourceWord & MODULE_BITS) !== 0
      ? ("module" as const)
      : (sourceWord & V8_CODE_CACHE_COMPILE_FUNCTION_BIT) !== 0
        ? ("compile_function" as const)
        : ("unknown" as const);

  return {
    header: {
      magic,
      magic_build_stable: magicHigh,
      fields,
      header_bytes: payloadOffset,
      source_length: sourceLength,
      producer,
    },
    payloadOffset,
    payloadLength: totalBytes - payloadOffset,
    sixWords,
  };
};

class V8CodeCachePayloadScanner {
  readonly #hash = createHash("sha256");
  readonly #observations: V8CodeCache["embedded_strings"] = [];
  readonly #runBuffer = Buffer.allocUnsafe(
    MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES,
  );
  readonly #payloadOffset: number;
  readonly #minStringBytes: number;
  readonly #maxStrings: number;
  #cursor = 0;
  #runStart = -1;
  #runLength = 0;
  // not-an-allowance: fixed scratch buffer write length capped at MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES
  #retainedLength = 0;

  constructor(payloadOffset: number, input: V8CodeCacheInputBudget) {
    this.#payloadOffset = payloadOffset;
    this.#minStringBytes = input.min_string_bytes;
    this.#maxStrings = input.max_strings;
  }

  #flush(): void {
    if (this.#runStart < 0) return;
    const runBytes = this.#runLength;
    if (runBytes >= this.#minStringBytes) {
      if (this.#observations.length >= this.#maxStrings)
        // The message states the fact. Recovery advice belongs to the provider, which
        // can see whether either budget still has headroom before recommending a retry.
        throw decodeLimit(
          V8_CODE_CACHE_FORMAT,
          `Payload contains more than ${String(this.#maxStrings)} printable runs of at least ${String(this.#minStringBytes)} bytes, so the max_strings observation budget was exhausted before the scan finished.`,
          { name: "max_strings", maximum: this.#maxStrings },
        );
      const retained = this.#retainedLength;
      this.#observations.push({
        offset: this.#payloadOffset + this.#runStart,
        bytes: runBytes,
        retained_bytes: retained,
        truncated: retained < runBytes,
        text: this.#runBuffer.toString("latin1", 0, retained),
      });
    }
    this.#runStart = -1;
    this.#runLength = 0;
    this.#retainedLength = 0;
  }

  update(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#hash.update(chunk);
    const length = chunk.length;
    for (let index = 0; index < length; index += 1) {
      const byte = chunk[index]!;
      if (isPrintable(byte)) {
        if (this.#runStart < 0) this.#runStart = this.#cursor;
        if (this.#retainedLength < MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES) {
          this.#runBuffer[this.#retainedLength] = byte;
          this.#retainedLength += 1;
        }
        this.#runLength += 1;
      } else {
        this.#flush();
      }
      this.#cursor += 1;
    }
  }

  finish(): {
    readonly sha256: string;
    readonly scannedBytes: number;
    readonly observations: V8CodeCache["embedded_strings"];
  } {
    this.#flush();
    return {
      sha256: this.#hash.digest("hex"),
      scannedBytes: this.#cursor,
      observations: this.#observations,
    };
  }
}

const buildV8CodeCacheReport = (
  parsed: ParsedV8Header,
  artifact: { path: string; sha256: string; bytes: number },
  scanned: ReturnType<V8CodeCachePayloadScanner["finish"]>,
): V8CodeCache => ({
  artifact,
  header: parsed.header,
  payload: {
    offset: parsed.payloadOffset,
    bytes: parsed.payloadLength,
    sha256: scanned.sha256,
    trailing_bytes: 0,
  },
  embedded_strings: scanned.observations,
  coverage: {
    status: "complete",
    scanned_bytes: scanned.scannedBytes,
    strings: scanned.observations.length,
  },
  limitations: parsed.sixWords
    ? [...LIMITATIONS, LEGACY_LIMITATION]
    : LIMITATIONS,
});

/** Stream one V8 code cache container over a bounded file handle in fixed chunks. */
export const parseV8CodeCacheFromHandle = async (
  source: PrefixedByteSource,
  artifact: { path: string; sha256: string; bytes: number },
  input: V8CodeCacheInputBudget,
): Promise<V8CodeCache> => {
  if (source.size !== artifact.bytes)
    malformed("Selected artifact length disagrees with the retained bytes.");
  const headerNeeded = Math.min(source.size, V8_CODE_CACHE_HEADER_BYTES);
  const headerBytes =
    source.prefix.length >= headerNeeded
      ? source.prefix
      : await readAdmittedRange("V8 code cache", source, 0, headerNeeded);
  const parsed = parseV8CodeCacheHeader(headerBytes, source.size);
  const scanner = new V8CodeCachePayloadScanner(parsed.payloadOffset, input);
  let cursor = parsed.payloadOffset;
  if (source.prefix.length > cursor) {
    scanner.update(source.prefix.subarray(cursor));
    cursor = source.prefix.length;
  }
  while (cursor < source.size) {
    const length = Math.min(STREAM_CHUNK_BYTES, source.size - cursor);
    scanner.update(
      await readAdmittedRange("V8 code cache", source, cursor, length),
    );
    cursor += length;
  }
  return buildV8CodeCacheReport(parsed, artifact, scanner.finish());
};
