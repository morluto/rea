import { BinaryReader } from "../domain/binaryContainer.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { parseJsonStringLiteral } from "../domain/jsonDuplicateMember.js";
import { escapeJsonPointerToken } from "../domain/jsonPointer.js";
import { setImmediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../resources/index.js";
import type {
  ModelMetadata,
  ModelTensor,
} from "../domain/model/modelArtifact.js";
import { ModelHeaderReader } from "./ModelHeaderReader.js";
import {
  MODEL_HEADER_BYTES,
  MODEL_JSON_NESTING,
  modelCapacityFailure,
  ModelReportBudget,
  rejectModel,
  rejectPickle,
} from "./ModelFormat.js";
import { safetensorsBits } from "./ModelTensorTypes.js";

class JsonNumber {
  constructor(readonly raw: string) {}
}
type HeaderValue =
  | string
  | bigint
  | boolean
  | null
  | JsonNumber
  | HeaderValue[]
  | { [key: string]: HeaderValue };

/** The format's restricted JSON header, with duplicate keys and exact integer checks at its owner. */
class HeaderJson {
  #position = 0;
  #nodes = 0;
  constructor(
    readonly text: string,
    readonly budget: ModelReportBudget,
  ) {}
  #space(): void {
    const text = this.text;
    const len = text.length;
    while (this.#position < len) {
      const code = text.charCodeAt(this.#position);
      if (code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a)
        this.#position++;
      else break;
    }
  }
  #string(): string {
    const start = this.#position++;
    const text = this.text;
    const len = text.length;
    while (this.#position < len) {
      const code = text.charCodeAt(this.#position++);
      if (code === 0x5c) this.#position++;
      else if (code === 0x22) {
        const raw = text.slice(start, this.#position);
        this.budget.charge(6 * raw.length + 2);
        try {
          const value: unknown = parseJsonStringLiteral(raw);
          if (typeof value !== "string")
            return rejectModel("Invalid JSON string");
          // `text` was decoded via strict UTF-8, so only `\u` escapes can
          // introduce unpaired UTF-16 surrogates.
          if (raw.includes("\\u")) {
            for (let i = 0; i < value.length; i++) {
              const code = value.charCodeAt(i);
              if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) i++;
                else
                  rejectModel(
                    "Safetensors JSON contains an unpaired surrogate",
                  );
              } else if (code >= 0xdc00 && code <= 0xdfff) {
                rejectModel("Safetensors JSON contains an unpaired surrogate");
              }
            }
          }
          return value;
        } catch (cause) {
          if (cause instanceof SyntaxError)
            rejectModel("Invalid safetensors JSON string");
          throw cause;
        }
      }
    }
    return rejectModel("Unterminated safetensors JSON string");
  }
  #number(): bigint | JsonNumber {
    const text = this.text;
    const len = text.length;
    const start = this.#position;
    let isNonNegativeInt = true;
    if (this.#position < len && text.charCodeAt(this.#position) === 0x2d) {
      this.#position++;
      isNonNegativeInt = false;
    }
    const integerStart = this.#position;
    if (this.#position < len) {
      const firstDigit = text.charCodeAt(this.#position);
      if (firstDigit === 0x30) {
        this.#position++;
      } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
        this.#position++;
        while (this.#position < len) {
          const d = text.charCodeAt(this.#position);
          if (d >= 0x30 && d <= 0x39) this.#position++;
          else break;
        }
      }
    }
    if (this.#position === integerStart)
      return rejectModel("Invalid safetensors JSON value");
    if (this.#position < len && text.charCodeAt(this.#position) === 0x2e) {
      isNonNegativeInt = false;
      this.#position++;
      const fractionStart = this.#position;
      while (this.#position < len) {
        const d = text.charCodeAt(this.#position);
        if (d >= 0x30 && d <= 0x39) this.#position++;
        else break;
      }
      if (this.#position === fractionStart)
        return rejectModel("Invalid safetensors JSON value");
    }
    if (this.#position < len) {
      const exp = text.charCodeAt(this.#position);
      if (exp === 0x65 || exp === 0x45) {
        isNonNegativeInt = false;
        this.#position++;
        if (this.#position < len) {
          const sign = text.charCodeAt(this.#position);
          if (sign === 0x2b || sign === 0x2d) this.#position++;
        }
        const exponentStart = this.#position;
        while (this.#position < len) {
          const d = text.charCodeAt(this.#position);
          if (d >= 0x30 && d <= 0x39) this.#position++;
          else break;
        }
        if (this.#position === exponentStart)
          return rejectModel("Invalid safetensors JSON value");
      }
    }
    const numeric = text.slice(start, this.#position);
    if (isNonNegativeInt) {
      if (numeric.length > 20) return new JsonNumber(numeric);
      const integer = BigInt(numeric);
      if (integer <= 0xffffffffffffffffn) return integer;
    }
    return new JsonNumber(numeric);
  }
  *read(): Generator<void, HeaderValue> {
    if (this.text[0] !== "{")
      rejectModel("Safetensors header must begin with a JSON object");
    type Frame =
      | {
          readonly kind: "object";
          readonly value: { [key: string]: HeaderValue };
          key: string;
        }
      | { readonly kind: "array"; readonly value: HeaderValue[] };
    const stack: Frame[] = [];
    let root: HeaderValue | undefined;
    // Iterative descent avoids allocating a JS Generator frame per JSON value.
    parseValue: while (true) {
      if (++this.#nodes % 4096 === 0) yield;
      this.#space();
      this.budget.charge(64);
      if (stack.length > MODEL_JSON_NESTING)
        throw modelCapacityFailure(
          "json-nesting",
          `Safetensors JSON nesting exceeds ${String(MODEL_JSON_NESTING)} levels`,
        );
      const c = this.text[this.#position];
      let value: HeaderValue;
      if (c === "{" || c === "[") {
        this.#position++;
        const close = c === "{" ? "}" : "]";
        this.#space();
        if (this.text[this.#position] === close) {
          this.#position++;
          value =
            c === "{"
              ? (Object.create(null) as { [key: string]: HeaderValue })
              : [];
        } else if (c === "{") {
          const object = Object.create(null) as { [key: string]: HeaderValue };
          if (this.text[this.#position] !== '"')
            rejectModel("Expected safetensors JSON object key");
          const key = this.#string();
          this.#space();
          if (this.text[this.#position++] !== ":")
            rejectModel("Expected safetensors JSON colon");
          stack.push({ kind: "object", value: object, key });
          continue parseValue;
        } else {
          stack.push({ kind: "array", value: [] });
          continue parseValue;
        }
      } else if (c === '"') {
        value = this.#string();
      } else if (this.text.startsWith("null", this.#position)) {
        this.#position += 4;
        value = null;
      } else if (this.text.startsWith("true", this.#position)) {
        this.#position += 4;
        value = true;
      } else if (this.text.startsWith("false", this.#position)) {
        this.#position += 5;
        value = false;
      } else {
        value = this.#number();
      }
      // Attach the completed value to its parent container and advance.
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.kind === "object") frame.value[frame.key] = value;
        else frame.value.push(value);
        this.#space();
        const next = this.text[this.#position++];
        const close = frame.kind === "object" ? "}" : "]";
        if (next === close) {
          stack.pop();
          value = frame.value;
          continue;
        }
        if (next !== ",") rejectModel("Invalid safetensors JSON container");
        if (frame.kind === "object") {
          this.#space();
          if (this.text[this.#position] !== '"')
            rejectModel("Expected safetensors JSON object key");
          const key = this.#string();
          if (Object.hasOwn(frame.value, key))
            rejectModel(`Duplicate safetensors JSON key ${key}`);
          this.#space();
          if (this.text[this.#position++] !== ":")
            rejectModel("Expected safetensors JSON colon");
          frame.key = key;
        }
        continue parseValue;
      }
      root = value;
      break;
    }
    this.#space();
    if (this.#position !== this.text.length)
      rejectModel("Trailing non-whitespace safetensors header bytes");
    return root;
  }
}

const objectOf = (
  value: HeaderValue | undefined,
): { [key: string]: HeaderValue } => {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof JsonNumber
  )
    return rejectModel("Expected safetensors header object");
  return value;
};
const integersOf = (value: HeaderValue | undefined): bigint[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is bigint => typeof item === "bigint")
  )
    return rejectModel("Expected safetensors integer array");
  return value;
};
const exactOffset = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw modelCapacityFailure(
      "exact-offset",
      "Safetensors data offset exceeds exact host offset precision",
    );
  return Number(value);
};

export const readSafetensorsHeader = async (
  reader: ModelHeaderReader,
  first: Buffer,
): Promise<{
  version: null;
  byte_order: "little";
  alignment: null;
  tensor_data_offset: number;
  metadata: ModelMetadata[];
  tensors: ModelTensor[];
  limitations: string[];
}> => {
  const budget = new ModelReportBudget();
  // Lengths such as 640 (80 02 ...) also begin like a pickle PROTO opcode.
  const protocol = first[1] ?? 0;
  const pickle = first[0] === 0x80 && protocol >= 2 && protocol <= 5;
  // ZIP's four-byte signature is also a valid little-endian header length.
  const zip = first.equals(Buffer.from([0x50, 0x4b, 3, 4]));
  if ((pickle || zip) && reader.size < 9) rejectPickle();
  const second = await reader.take(4);
  reader.excludeSafetensorsLengthPrefix();
  // first and second are exact four-byte takes of the little-endian u64 prefix.
  const length =
    new BinaryReader(first, true, "safetensors").word(0, 32) +
    (new BinaryReader(second, true, "safetensors").word(0, 32) << 32n);
  const brace = length === 0n ? undefined : (await reader.take(1))[0];
  // A brace after an admissible length is safetensors, even if truncated.
  if (
    (pickle || zip) &&
    (brace !== 0x7b || length > BigInt(MODEL_HEADER_BYTES))
  )
    rejectPickle();
  if (brace !== 0x7b)
    rejectModel("File does not contain a GGUF or safetensors header");
  reader.requireFileExtent(8, length);
  const size = Number(length);
  reader.guarantee(size - 1);
  // Native UTF-8 decode and the bounded JSON parser both retain header text.
  budget.charge(2 * size);
  let text: string;
  try {
    text = "{" + decodeStrictUtf8(await reader.take(size - 1), "preserve");
  } catch (cause) {
    if (cause instanceof TypeError)
      rejectModel("Safetensors header is not valid UTF-8");
    throw cause;
  }
  const steps = new HeaderJson(text, budget).read();
  let step = steps.next();
  while (!step.done) {
    await setImmediate();
    assertArtifactReadActive(reader.signal);
    step = steps.next();
  }
  const root = objectOf(step.value);
  const source = { source_offset: 8, source_length: size };
  const metadata: ModelMetadata[] = [];
  if (Object.hasOwn(root, "__metadata__") && root.__metadata__ !== null) {
    for (const [key, value] of Object.entries(objectOf(root.__metadata__))) {
      if (typeof value !== "string")
        rejectModel("Safetensors __metadata__ values must be strings");
      metadata.push({
        index: metadata.length,
        key,
        type: "STRING",
        value,
        element_type: null,
        element_count: null,
        preview_complete: true,
        ...source,
        json_pointer: `/__metadata__/${escapeJsonPointerToken(key)}`,
      });
    }
  }
  const tensors: ModelTensor[] = [];
  const unknownTypes = new Set<string>();
  const tensor_data_offset = 8 + size;
  const names = Object.keys(root)
    .filter((name) => name !== "__metadata__")
    .sort();
  budget.charge(names.length * 512);
  for (const name of names) {
    const entry = objectOf(root[name]);
    if (
      !Object.hasOwn(entry, "dtype") ||
      !Object.hasOwn(entry, "shape") ||
      !Object.hasOwn(entry, "data_offsets")
    )
      rejectModel(
        `Safetensors tensor ${name} must declare dtype, shape and data_offsets`,
      );
    const type = entry.dtype;
    if (typeof type !== "string")
      rejectModel(`Safetensors tensor ${name} dtype must be a string`);
    const shape = integersOf(entry.shape);
    const offsets = integersOf(entry.data_offsets);
    if (offsets.length !== 2)
      rejectModel(`Safetensors tensor ${name} requires two data offsets`);
    const rawStart = offsets[0] ?? 0n;
    const rawEnd = offsets[1] ?? 0n;
    if (rawStart < 0n || rawEnd < rawStart)
      rejectModel(`Safetensors tensor ${name} has an invalid data range`);
    reader.requireFileExtent(tensor_data_offset, rawEnd);
    const start = exactOffset(rawStart);
    const end = exactOffset(rawEnd);
    let parameters = 1n;
    for (const dimension of shape) {
      parameters *= dimension;
      if (parameters > 0xffffffffffffffffn)
        rejectModel(
          `Safetensors tensor ${name} parameter count overflows uint64`,
        );
    }
    const bits = safetensorsBits(type);
    if (bits === undefined) unknownTypes.add(type);
    if (bits !== undefined) {
      const expected = parameters * BigInt(bits);
      if (expected % 8n !== 0n || expected / 8n !== BigInt(end - start))
        rejectModel(
          `Safetensors tensor ${name} byte length does not match dtype and shape`,
        );
    }
    tensors.push({
      index: tensors.length,
      name,
      type,
      type_id: null,
      shape: shape.map(String),
      data_offset: start,
      file_offset: tensor_data_offset + start,
      byte_length: end - start,
      parameter_count: parameters.toString(),
      byte_length_state: "declared",
      storage_validation: bits === undefined ? "unknown" : "consistent",
      ...source,
      json_pointer: `/${escapeJsonPointerToken(name)}`,
    });
  }
  const ordered = [...tensors].sort(
    (a, b) =>
      a.data_offset - b.data_offset ||
      (a.byte_length ?? 0) - (b.byte_length ?? 0),
  );
  let end = 0;
  for (const tensor of ordered) {
    if (tensor.data_offset !== end)
      rejectModel(
        `Safetensors data ${tensor.data_offset < end ? "overlap" : "gap"} before ${tensor.name}: expected ${String(end)}, observed ${String(tensor.data_offset)}`,
      );
    end = tensor.data_offset + (tensor.byte_length ?? 0);
  }
  if (end !== reader.size - tensor_data_offset)
    rejectModel(
      `Safetensors unindexed trailing data: ${String(reader.size - tensor_data_offset - end)} bytes`,
    );
  return {
    version: null,
    byte_order: "little",
    alignment: null,
    tensor_data_offset,
    metadata,
    tensors,
    limitations:
      unknownTypes.size === 0
        ? []
        : [
            `Unknown tensor types prevent storage-size validation: ${[...unknownTypes].join(", ")}`,
          ],
  };
};
