import { strictUtf8Decoder } from "../domain/strictUtf8.js";
import { EvmAdmissionError } from "./EvmAdmissionError.js";
import { decode, Tokenizer, Type, type Token } from "cborg";
import type {
  SolidityMetadata,
  SolidityMetadataScalar,
} from "../domain/evm/solidityMetadata.js";
import { errorMessage } from "../kernel/errorMessage.js";

const PROFILE = "terminal-cbor-scalars-v1";
const MAX_DEPTH = 64;
const utf8 = strictUtf8Decoder("preserve");
const decodeOptions = {
  useMaps: true,
  allowBigInt: true,
  allowIndefinite: false,
  allowUndefined: false,
  allowInfinity: false,
  allowNaN: false,
  rejectDuplicateMapKeys: false,
  retainStringBytes: false,
} as const;

const uint8ArrayToHex = (bytes: Uint8Array): string =>
  Buffer.isBuffer(bytes)
    ? bytes.toString("hex")
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        "hex",
      );

const stringPrefixBytes = (minor: number): number => {
  if (minor < 24) return 1;
  if (minor === 24) return 2;
  if (minor === 25) return 3;
  if (minor === 26) return 5;
  if (minor === 27) return 9;
  return -1;
};

const decodeStrictTokenText = (
  data: Uint8Array,
  startPos: number,
  token: Token,
): void => {
  const encodedLength = token.encodedLength;
  const prefix =
    startPos < data.length ? stringPrefixBytes(data[startPos]! & 31) : -1;
  if (encodedLength === undefined || prefix < 0)
    throw new EvmAdmissionError("text_bytes_unavailable");
  const byteLength = encodedLength - prefix;
  const text = token.value as string;
  // cborg uses non-fatal TextDecoder and may strip BOM; pure ASCII is exact
  // whenever byte length matches UTF-16 length and has no U+FFFD.
  if (byteLength !== text.length || text.includes("\uFFFD"))
    token.value = utf8.decode(
      data.subarray(startPos + prefix, startPos + encodedLength),
    );
};

const fastScalarKey = (value: unknown): string => {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "bigint") return `i:${value.toString()}`;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return `i:${String(value)}`;
  if (typeof value === "boolean") return value ? "T" : "F";
  if (value === null) return "N";
  if (value instanceof Uint8Array) return `b:${uint8ArrayToHex(value)}`;
  throw new EvmAdmissionError("value_outside_profile");
};

/** Bound recursive decoder entry before collection interpretation/allocation. */
class BoundedMetadataTokenizer extends Tokenizer {
  readonly remaining: number[] = [];
  readonly #mapKeys: Array<Set<string> | undefined> = [];
  hasContainerKey = false;

  constructor(bytes: Uint8Array) {
    super(bytes, decodeOptions);
  }

  override next(): Token {
    while (
      this.remaining.length > 0 &&
      this.remaining[this.remaining.length - 1] === 0
    ) {
      this.remaining.pop();
      this.#mapKeys.pop();
    }
    const startPos = this.pos();
    const token = super.next();
    const type = token.type;
    if (Type.equals(type, Type.tag) || Type.equals(type, Type.float))
      throw new EvmAdmissionError("tag_or_float");
    if (Type.equals(type, Type.string))
      decodeStrictTokenText(this.data, startPos, token);
    const isMap = Type.equals(type, Type.map);
    const isArray = !isMap && Type.equals(type, Type.array);
    this.#trackMapKey(token, isMap, isArray);
    if (isMap || isArray) this.#enterCollection(token, isMap);
    return token;
  }

  #trackMapKey(token: Token, isMap: boolean, isArray: boolean): void {
    const parent = this.remaining.length - 1;
    if (parent < 0) return;
    const mapKeys = this.#mapKeys[parent];
    const onKey = mapKeys !== undefined && this.remaining[parent]! % 2 === 0;
    this.remaining[parent]!--;
    if (!onKey || mapKeys === undefined) return;
    if (isMap || isArray) {
      this.hasContainerKey = true;
      return;
    }
    const fast = fastScalarKey(token.value);
    if (mapKeys.has(fast)) throw repeatedMapKey(keyIdentity(token.value));
    mapKeys.add(fast);
  }

  #enterCollection(token: Token, isMap: boolean): void {
    const count: unknown = token.value;
    const children = typeof count === "number" ? count * (isMap ? 2 : 1) : NaN;
    if (
      !Number.isSafeInteger(children) ||
      children < 0 ||
      children > this.data.length
    )
      throw new EvmAdmissionError("collection_exceeds_bound");
    if (this.remaining.length >= MAX_DEPTH)
      throw new EvmAdmissionError("nesting_exceeds_profile", {
        max_depth: MAX_DEPTH,
      });
    this.#mapKeys.push(isMap ? new Set() : undefined);
    this.remaining.push(children);
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
    return { kind: "bytes", value: uint8ArrayToHex(value) };
  if (value instanceof Map) return { kind: "uninterpreted", container: "map" };
  if (Array.isArray(value))
    return { kind: "uninterpreted", container: "array" };
  throw new EvmAdmissionError("value_outside_profile");
};

/** Value identity for duplicate-key checks; map entry order is not significant. */
const keyIdentity = (value: unknown): string => {
  if (value instanceof Map)
    return `{${[...value]
      .map(([key, item]) => `${keyIdentity(key)}:${keyIdentity(item)}`)
      .sort()
      .join(",")}}`;
  if (Array.isArray(value)) return `[${value.map(keyIdentity).join(",")}]`;
  return JSON.stringify(scalar(value));
};

const repeatedMapKey = (identity: string): EvmAdmissionError =>
  new EvmAdmissionError(
    "repeated_map_key",
    identity.length <= 128
      ? { key: identity }
      : { key_length: identity.length },
  );

/** Check every map boundary, even when nested values remain uninterpreted. */
const validateMapKeys = (value: unknown): void => {
  if (value instanceof Map) {
    const seen = new Set<string>();
    for (const [key, item] of value) {
      const identity = keyIdentity(key);
      if (seen.has(identity)) throw repeatedMapKey(identity);
      seen.add(identity);
      validateMapKeys(key);
      validateMapKeys(item);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) validateMapKeys(item);
  }
};

/** Keep the typed code and its detail; map only the decoder's duplicate-key throw. */
const solidityFailure = (
  cause: unknown,
): {
  readonly diagnostic: string;
  readonly admission?: {
    readonly code: string;
    readonly detail?: Readonly<Record<string, string | number>>;
  };
} => {
  if (cause instanceof EvmAdmissionError)
    return {
      diagnostic: cause.code,
      admission: {
        code: cause.code,
        ...(cause.detail === undefined ? {} : { detail: cause.detail }),
      },
    };
  return {
    diagnostic: errorMessage(cause).slice(0, 512),
  };
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
    const tokenizer = new BoundedMetadataTokenizer(selected);
    const raw: unknown = decode(selected, {
      ...decodeOptions,
      tokenizer,
    });
    if (!(raw instanceof Map)) throw new EvmAdmissionError("root_not_map");
    if (tokenizer.hasContainerKey) validateMapKeys(raw);
    // cborg compares Map keys by identity, so repeated byte-string or container
    // keys (each its own object) pass its duplicate check; compare by value at
    // every map boundary before projecting any entries.
    let hasUninterpreted = false;
    for (const [key, value] of raw as Map<unknown, unknown>) {
      const projectedKey = scalar(key);
      const projectedValue = scalar(value);
      if (
        projectedKey.kind === "uninterpreted" ||
        projectedValue.kind === "uninterpreted"
      )
        hasUninterpreted = true;
      result.entries.push({ key: projectedKey, value: projectedValue });
    }
    result.status = hasUninterpreted ? "partial" : "decoded";
    result.diagnostic = hasUninterpreted
      ? "Nested containers are uninterpreted; their exact bytes remain at the recorded range in original bytecode."
      : null;
    const version: unknown = raw.get("solc");
    if (version instanceof Uint8Array && version.length === 3)
      result.compiler_version = {
        representation: "release-bytes",
        value: `${version[0]}.${version[1]}.${version[2]}`,
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
      ...solidityFailure(cause),
    };
  }
};
