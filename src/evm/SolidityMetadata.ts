import { decode, Tokenizer, Type, type Token } from "cborg";
import type {
  SolidityMetadata,
  SolidityMetadataScalar,
} from "../domain/evm/solidityMetadata.js";

const PROFILE = "terminal-cbor-scalars-v1";
const MAX_DEPTH = 64;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decodeOptions = {
  useMaps: true,
  allowBigInt: true,
  allowIndefinite: false,
  allowUndefined: false,
  allowInfinity: false,
  allowNaN: false,
  rejectDuplicateMapKeys: true,
  retainStringBytes: true,
} as const;

/** Bound recursive decoder entry before collection interpretation/allocation. */
class BoundedMetadataTokenizer extends Tokenizer {
  readonly remaining: number[] = [];
  constructor(bytes: Uint8Array) {
    super(bytes, decodeOptions);
  }

  override next(): Token {
    while (this.remaining.at(-1) === 0) this.remaining.pop();
    const token = super.next();
    if (
      Type.equals(token.type, Type.tag) ||
      Type.equals(token.type, Type.float)
    )
      throw new Error(
        "CBOR tags and floating-point values are outside this metadata profile.",
      );
    if (Type.equals(token.type, Type.string)) {
      if (token.byteValue === undefined)
        throw new Error(
          "CBOR text bytes were unavailable for strict UTF-8 validation.",
        );
      token.value = utf8.decode(token.byteValue);
    }
    const parent = this.remaining.length - 1;
    if (parent >= 0) this.remaining[parent]!--;
    if (
      Type.equals(token.type, Type.map) ||
      Type.equals(token.type, Type.array)
    ) {
      const count: unknown = token.value;
      const children =
        typeof count === "number"
          ? count * (Type.equals(token.type, Type.map) ? 2 : 1)
          : NaN;
      if (
        !Number.isSafeInteger(children) ||
        children < 0 ||
        children > this.data.length
      )
        throw new Error(
          "Declared CBOR collection exceeds the encoded item-byte bound.",
        );
      if (this.remaining.length >= MAX_DEPTH)
        throw new Error("CBOR nesting exceeds the 64-level metadata profile.");
      this.remaining.push(children);
    }
    return token;
  }
}

const scalar = (value: unknown): SolidityMetadataScalar => {
  if (typeof value === "string") return { kind: "text", value };
  if (typeof value === "bigint")
    return { kind: "integer", value: value.toString() };
  if (typeof value === "number" && Number.isSafeInteger(value))
    return { kind: "integer", value: String(value) };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (value === null) return { kind: "null" };
  if (value instanceof Uint8Array)
    return { kind: "bytes", value: Buffer.from(value).toString("hex") };
  if (value instanceof Map) return { kind: "uninterpreted", container: "map" };
  if (Array.isArray(value))
    return { kind: "uninterpreted", container: "array" };
  throw new Error(
    "CBOR decoder returned a value outside the admitted profile.",
  );
};

/** Parse only a plausible terminal root-map candidate; never establish absence. */
export const inspectSolidityMetadata = (
  bytes: Uint8Array,
): SolidityMetadata => {
  const empty: SolidityMetadata = {
    profile: PROFILE,
    status: "unavailable",
    bytecode_offset: null,
    cbor_bytes: null,
    entries: [],
    compiler_version: null,
    diagnostic:
      "No plausible terminal CBOR map was identified; Solidity origin and metadata absence remain unknown.",
  };
  if (bytes.length < 3) return empty;
  const length = bytes[bytes.length - 2]! * 256 + bytes[bytes.length - 1]!;
  const offset = bytes.length - 2 - length;
  if (length === 0 || offset < 0 || bytes[offset]! >> 5 !== 5) return empty;
  const selected = bytes.subarray(offset, bytes.length - 2);
  const result: SolidityMetadata = {
    ...empty,
    status: "not-decoded",
    bytecode_offset: offset,
    cbor_bytes: length,
  };
  try {
    const raw: unknown = decode(selected, {
      ...decodeOptions,
      tokenizer: new BoundedMetadataTokenizer(selected),
    });
    if (!(raw instanceof Map))
      throw new Error("Terminal CBOR candidate did not decode to a root map.");
    for (const [key, value] of raw as Map<unknown, unknown>)
      result.entries.push({ key: scalar(key), value: scalar(value) });
    result.status = result.entries.some(
      ({ key, value }) =>
        key.kind === "uninterpreted" || value.kind === "uninterpreted",
    )
      ? "partial"
      : "decoded";
    result.diagnostic =
      result.status === "partial"
        ? "Nested containers are uninterpreted; their exact bytes remain at the recorded range in original bytecode."
        : null;
    const version: unknown = raw.get("solc");
    if (version instanceof Uint8Array && version.length === 3)
      result.compiler_version = {
        representation: "release-bytes",
        value: [...version].join("."),
      };
    else if (typeof version === "string" && version.length > 0)
      result.compiler_version = {
        representation: "prerelease-text",
        value: version,
      };
    return result;
  } catch (cause: unknown) {
    return {
      ...result,
      status: "not-decoded",
      entries: [],
      compiler_version: null,
      diagnostic: (cause instanceof Error
        ? cause.message
        : String(cause)
      ).slice(0, 512),
    };
  }
};
