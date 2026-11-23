import { isUtf8 } from "node:buffer";
import type { FridaMessage } from "frida";

import type { FridaRemoteConnection } from "../ports/frida/FridaInstrumentationPort.js";
import {
  explicitValueSpans,
  explicitValuesOccurIn,
} from "../domain/explicitSensitiveValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import {
  MAX_MESSAGE_METADATA_BYTES,
  type FridaOwnedCaptureLimit,
} from "../domain/fridaCaptureLimits.js";
import type { FridaCapturePolicy } from "../domain/fridaCapturePolicy.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

export interface FridaCaptureContext {
  readonly captureLimits: FridaCapturePolicy;
  readonly secrets: readonly string[];
}

const FIELD_PREFIX_BYTES = {
  base: Buffer.byteLength('{"script_id":}'),
  type: Buffer.byteLength(',"type":'),
  typeTruncated: Buffer.byteLength(',"type_truncated":true'),
  payload: Buffer.byteLength(',"payload":'),
  payloadTruncated: Buffer.byteLength(',"payload_truncated":true'),
  payloadLimit: Buffer.byteLength(',"payload_capture_limit":'),
  description: Buffer.byteLength(',"description":'),
  descriptionTruncated: Buffer.byteLength(',"description_truncated":true'),
  stack: Buffer.byteLength(',"stack":'),
  stackTruncated: Buffer.byteLength(',"stack_truncated":true'),
  fileName: Buffer.byteLength(',"file_name":'),
  fileNameTruncated: Buffer.byteLength(',"file_name_truncated":true'),
  lineNumber: Buffer.byteLength(',"line_number":'),
  columnNumber: Buffer.byteLength(',"column_number":'),
  dataRedacted: Buffer.byteLength(',"data_redacted":true'),
  dataTruncatedPrefix: Buffer.byteLength(
    ',"data_truncated":true,"data_bytes":',
  ),
  dataTruncatedSuffix: Buffer.byteLength(
    ',"data_capture_limit":"session_bytes"',
  ),
  dataBase64: Buffer.byteLength(',"data_base64":'),
} as const;

const PAYLOAD_UNAVAILABLE_BYTES = Buffer.byteLength(
  '{"payload_unavailable":true}',
);

export const remoteSecrets = (
  remote?: FridaRemoteConnection,
): readonly string[] => {
  const secrets: string[] = [];
  if (remote?.token !== undefined && remote.token.length > 0)
    secrets.push(remote.token);
  if (remote?.certificate !== undefined && remote.certificate.length > 0)
    secrets.push(remote.certificate);
  return secrets;
};

const captureBoundedPayload = (
  payload: unknown,
  limits: FridaCapturePolicy,
  secrets: readonly string[],
): BoundedJson | undefined => {
  if (payload === undefined) return undefined;
  try {
    return boundedJsonValue(
      payload,
      Math.max(0, limits.session_bytes - MAX_MESSAGE_METADATA_BYTES),
      secrets,
      limits,
    );
  } catch {
    return {
      value: { payload_unavailable: true },
      truncated: true,
      bytes: PAYLOAD_UNAVAILABLE_BYTES,
      limit: "unrepresentable",
    };
  }
};

const captureBinaryData = (
  data: Buffer | null,
  payloadBytes: number,
  limits: FridaCapturePolicy,
  secrets: readonly string[],
): {
  readonly fields: Record<string, JsonValue>;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  if (data === null) return { fields: {}, bytes: 0, truncated: false };
  const remainingMessageBytes = Math.max(
    0,
    limits.session_bytes - MAX_MESSAGE_METADATA_BYTES - payloadBytes - 4096,
  );
  const messageBinaryLimit = Math.floor((remainingMessageBytes * 3) / 4);
  if (secrets.some((secret) => data.includes(secret, 0, "utf8"))) {
    return {
      fields: { data_redacted: true },
      bytes: FIELD_PREFIX_BYTES.dataRedacted,
      truncated: false,
    };
  }
  if (data.byteLength > messageBinaryLimit) {
    return {
      fields: {
        data_truncated: true,
        data_bytes: data.byteLength,
        data_capture_limit: "session_bytes",
      },
      bytes:
        FIELD_PREFIX_BYTES.dataTruncatedPrefix +
        String(data.byteLength).length +
        FIELD_PREFIX_BYTES.dataTruncatedSuffix,
      truncated: true,
    };
  }
  const encoded = data.toString("base64");
  return {
    fields: { data_base64: encoded },
    bytes: FIELD_PREFIX_BYTES.dataBase64 + 2 + encoded.length,
    truncated: false,
  };
};

const REDACTED_MARKER = "[redacted]";
const REDACTED_BODY_BYTES = 10;

const CONTROL_CHAR_JSON_BYTES = (unit: number): number =>
  unit === 0x08 ||
  unit === 0x09 ||
  unit === 0x0a ||
  unit === 0x0c ||
  unit === 0x0d
    ? 2
    : 6;

const scanBoundedJsonBody = (
  input: string,
  start: number,
  end: number,
  remainingBytes: number,
): { readonly cursor: number; readonly bytes: number } => {
  let cursor = start;
  let bytes = 0;
  while (cursor < end) {
    const unit = input.charCodeAt(cursor);
    let charBytes: number;
    let step = 1;
    if (unit >= 0x20 && unit < 0x80) {
      charBytes = unit === 0x22 || unit === 0x5c ? 2 : 1;
    } else if (unit < 0x20) {
      charBytes = CONTROL_CHAR_JSON_BYTES(unit);
    } else if (unit < 0x800) {
      charBytes = 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = input.charCodeAt(cursor + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charBytes = 4;
        step = 2;
      } else {
        charBytes = 6;
      }
    } else {
      charBytes = unit >= 0xdc00 && unit <= 0xdfff ? 6 : 3;
    }
    if (cursor + step > end || bytes + charBytes > remainingBytes) break;
    bytes += charBytes;
    cursor += step;
  }
  return { cursor, bytes };
};

const isSafeNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const assignTextField = (
  target: Record<string, JsonValue>,
  key: string,
  field: BoundedRedactedText | undefined,
  prefixBytes: number,
  truncatedBytes: number,
): number => {
  if (field === undefined) return 0;
  target[key] = field.value;
  if (!field.truncated) return prefixBytes + field.bytes;
  target[`${key}_truncated`] = true;
  return prefixBytes + field.bytes + truncatedBytes;
};

const assignPayloadField = (
  target: Record<string, JsonValue>,
  payload: BoundedJson | undefined,
): number => {
  if (payload === undefined) return 0;
  target.payload = payload.value;
  let bytes = FIELD_PREFIX_BYTES.payload + payload.bytes;
  if (!payload.truncated) return bytes;
  target.payload_truncated = true;
  bytes += FIELD_PREFIX_BYTES.payloadTruncated;
  if (payload.limit !== undefined) {
    target.payload_capture_limit = payload.limit;
    bytes += FIELD_PREFIX_BYTES.payloadLimit + 2 + payload.limit.length;
  }
  return bytes;
};

export const buildCapturedObservation = (
  managed: FridaCaptureContext,
  scriptId: string,
  message: FridaMessage,
  data: Buffer | null,
): {
  readonly observation: JsonValue;
  readonly charge: number;
  readonly binaryTruncated: boolean;
} => {
  const limits = managed.captureLimits;
  const secrets = managed.secrets;
  const payload = captureBoundedPayload(message.payload, limits, secrets);
  const binary = captureBinaryData(data, payload?.bytes ?? 0, limits, secrets);
  const type = boundedRedactedString(
    message.type,
    limits.message_type_bytes,
    secrets,
  );
  const description =
    message.description === undefined
      ? undefined
      : boundedRedactedString(
          message.description,
          limits.message_text_bytes,
          secrets,
        );
  const stack =
    message.stack === undefined
      ? undefined
      : boundedRedactedString(
          message.stack,
          limits.message_text_bytes,
          secrets,
        );
  const fileName =
    message.fileName === undefined
      ? undefined
      : boundedRedactedString(
          message.fileName,
          limits.message_text_bytes,
          secrets,
        );
  const observation: Record<string, JsonValue> = {
    script_id: scriptId,
    type: type.value,
    ...(type.truncated ? { type_truncated: true } : {}),
  };
  let charge =
    FIELD_PREFIX_BYTES.base +
    jsonStringByteLength(scriptId) +
    FIELD_PREFIX_BYTES.type +
    type.bytes +
    (type.truncated ? FIELD_PREFIX_BYTES.typeTruncated : 0);
  charge += assignPayloadField(observation, payload);
  charge += assignTextField(
    observation,
    "description",
    description,
    FIELD_PREFIX_BYTES.description,
    FIELD_PREFIX_BYTES.descriptionTruncated,
  );
  charge += assignTextField(
    observation,
    "stack",
    stack,
    FIELD_PREFIX_BYTES.stack,
    FIELD_PREFIX_BYTES.stackTruncated,
  );
  charge += assignTextField(
    observation,
    "file_name",
    fileName,
    FIELD_PREFIX_BYTES.fileName,
    FIELD_PREFIX_BYTES.fileNameTruncated,
  );
  if (isSafeNonNegativeInt(message.lineNumber)) {
    observation.line_number = message.lineNumber;
    charge += FIELD_PREFIX_BYTES.lineNumber + String(message.lineNumber).length;
  }
  if (isSafeNonNegativeInt(message.columnNumber)) {
    observation.column_number = message.columnNumber;
    charge +=
      FIELD_PREFIX_BYTES.columnNumber + String(message.columnNumber).length;
  }
  Object.assign(observation, binary.fields);
  return {
    observation,
    charge: charge + binary.bytes,
    binaryTruncated: binary.truncated,
  };
};

type BoundedRedactedText = {
  readonly value: string;
  readonly truncated: boolean;
  readonly bytes: number;
};

export const boundedRedactedString = (
  input: string,
  maximumBytes: number,
  secrets: readonly string[],
): BoundedRedactedText => {
  if (secrets.length === 0 || !explicitValuesOccurIn(input, secrets)) {
    if (input.length * 6 <= maximumBytes)
      return {
        value: input,
        truncated: false,
        bytes: jsonStringByteLength(input),
      };
    const fit = scanBoundedJsonBody(input, 0, input.length, maximumBytes);
    return fit.cursor === input.length
      ? { value: input, truncated: false, bytes: fit.bytes + 2 }
      : {
          value: input.slice(0, fit.cursor),
          truncated: true,
          bytes: fit.bytes + 2,
        };
  }
  const chunks: string[] = [];
  let outputBytes = 0;
  let cursor = 0;
  for (const span of explicitValueSpans(input, secrets)) {
    const kept = scanBoundedJsonBody(
      input,
      cursor,
      span.start,
      maximumBytes - outputBytes,
    );
    chunks.push(input.slice(cursor, kept.cursor));
    outputBytes += kept.bytes;
    cursor = kept.cursor;
    if (
      cursor !== span.start ||
      outputBytes + REDACTED_BODY_BYTES > maximumBytes
    )
      return {
        value: chunks.join(""),
        truncated: true,
        bytes: outputBytes + 2,
      };
    chunks.push(REDACTED_MARKER);
    outputBytes += REDACTED_BODY_BYTES;
    cursor = span.end;
  }
  const tail = scanBoundedJsonBody(
    input,
    cursor,
    input.length,
    maximumBytes - outputBytes,
  );
  chunks.push(input.slice(cursor, tail.cursor));
  outputBytes += tail.bytes;
  return {
    value: chunks.join(""),
    truncated: tail.cursor !== input.length,
    bytes: outputBytes + 2,
  };
};

type BoundedJson = {
  readonly value: JsonValue;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly limit?: FridaOwnedCaptureLimit;
};

const clipped = (limit: FridaOwnedCaptureLimit): BoundedJson => ({
  value: null,
  truncated: true,
  bytes: 4,
  limit,
});

const boundedJsonArray = (
  value: readonly unknown[],
  budget: number,
  depth: number,
  visit: (value: unknown, budget: number, depth: number) => BoundedJson,
): BoundedJson => {
  const output: JsonValue[] = [];
  let usedBytes = 2;
  let limit: FridaOwnedCaptureLimit | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const separatorBytes = output.length === 0 ? 0 : 1;
    const remaining = budget - usedBytes - separatorBytes - 1;
    if (remaining < 8) {
      limit ??= "payload_bytes";
      break;
    }
    const item = visit(value[index] ?? null, remaining, depth + 1);
    if (item.bytes > remaining) {
      limit ??= "payload_bytes";
      break;
    }
    output.push(item.value);
    usedBytes += separatorBytes + item.bytes;
    if (item.truncated) {
      limit ??= item.limit;
      break;
    }
  }
  if (output.length < value.length) limit ??= "payload_bytes";
  return limit === undefined
    ? { value: output, truncated: false, bytes: usedBytes }
    : { value: output, truncated: true, bytes: usedBytes, limit };
};

const boundedJsonObject = (
  value: object,
  budget: number,
  depth: number,
  context: {
    readonly secrets: readonly string[];
    readonly visit: (
      value: unknown,
      budget: number,
      depth: number,
    ) => BoundedJson;
  },
): BoundedJson => {
  const output: Record<string, JsonValue> = {};
  let usedBytes = 2;
  let entries = 0;
  let limit: FridaOwnedCaptureLimit | undefined;
  for (const rawKey in value) {
    if (!Object.hasOwn(value, rawKey)) continue;
    const separatorBytes = entries === 0 ? 0 : 1;
    const keyLimit = Math.max(0, budget - usedBytes - separatorBytes - 10);
    const boundedKey = boundedRedactedString(rawKey, keyLimit, context.secrets);
    if (boundedKey.truncated) {
      limit ??= "payload_bytes";
      break;
    }
    const key = boundedKey.value;
    // Redaction can collapse source names; never replace a retained fact.
    if (Object.hasOwn(output, key)) {
      limit ??= "unrepresentable";
      break;
    }
    const keyBytes = boundedKey.bytes + 1;
    const remaining = budget - usedBytes - separatorBytes - keyBytes - 1;
    if (remaining < 8) {
      limit ??= "payload_bytes";
      break;
    }
    const entry = context.visit(
      Reflect.get(value, rawKey),
      remaining,
      depth + 1,
    );
    if (entry.bytes > remaining) {
      limit ??= "payload_bytes";
      break;
    }
    Object.defineProperty(output, key, {
      value: entry.value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    entries += 1;
    usedBytes += separatorBytes + keyBytes + entry.bytes;
    if (entry.truncated) {
      limit ??= entry.limit;
      break;
    }
  }
  return limit === undefined
    ? { value: output, truncated: false, bytes: usedBytes }
    : { value: output, truncated: true, bytes: usedBytes, limit };
};

const boundedJsonValue = (
  input: unknown,
  maximumBytes: number,
  secrets: readonly string[],
  limits: FridaCapturePolicy,
): BoundedJson => {
  const seen = new WeakSet<object>();
  let remainingNodes = limits.json_nodes;
  const visit = (
    value: unknown,
    budget: number,
    depth: number,
  ): BoundedJson => {
    remainingNodes -= 1;
    if (remainingNodes < 0) return clipped("json_nodes");
    if (depth > limits.json_depth) return clipped("json_depth");
    if (budget < 8) return clipped("payload_bytes");
    if (value === null) return { value: null, truncated: false, bytes: 4 };
    if (typeof value === "boolean")
      return { value, truncated: false, bytes: value ? 4 : 5 };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return clipped("unrepresentable");
      return { value, truncated: false, bytes: String(value).length };
    }
    if (typeof value === "string") {
      const bounded = boundedRedactedString(
        value,
        Math.max(0, budget - 2),
        secrets,
      );
      return bounded.truncated
        ? {
            value: bounded.value,
            truncated: true,
            bytes: bounded.bytes,
            limit: "payload_bytes",
          }
        : { value: bounded.value, truncated: false, bytes: bounded.bytes };
    }
    if (typeof value !== "object") return clipped("unrepresentable");
    if (seen.has(value)) return clipped("unrepresentable");
    seen.add(value);
    try {
      return Array.isArray(value)
        ? boundedJsonArray(value, budget, depth, visit)
        : boundedJsonObject(value, budget, depth, { secrets, visit });
    } finally {
      seen.delete(value);
    }
  };
  const result = visit(input, maximumBytes, 0);
  return result.bytes > maximumBytes
    ? clipped(result.limit ?? "payload_bytes")
    : result;
};
