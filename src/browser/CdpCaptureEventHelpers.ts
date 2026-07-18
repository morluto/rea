import {
  isHttpUrl,
  numberValue,
  recordValue,
  recordsValue,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

export const firstCallFrame = (
  value: UnknownRecord | undefined,
): UnknownRecord | undefined => recordsValue(value?.callFrames)[0];

export const initiatorLocation = (
  initiator: UnknownRecord | undefined,
): UnknownRecord | undefined => {
  let stack = recordValue(initiator?.stack);
  for (let depth = 0; depth < 32 && stack !== undefined; depth += 1) {
    const frame = firstCallFrame(stack);
    if (frame !== undefined) return frame;
    stack = recordValue(stack.parent);
  }
  return stringValue(initiator?.url) === undefined ? undefined : initiator;
};

export const exclusionReasonForUrl = (
  value: string | undefined,
): "disallowed_origin" | "unsupported_url" | "unattributed_origin" =>
  value === undefined || value === ""
    ? "unattributed_origin"
    : isHttpUrl(value)
      ? "disallowed_origin"
      : "unsupported_url";

export const integerOrNull = (value: unknown): number | null => {
  const number = numberValue(value);
  return number === undefined ? null : Math.max(0, Math.trunc(number));
};

export const executionContextKey = (value: unknown): string | null => {
  const identifier = numberValue(value);
  return identifier !== undefined && Number.isSafeInteger(identifier)
    ? String(identifier)
    : null;
};

export const isJsonContentType = (
  headers: UnknownRecord | undefined,
): boolean => {
  if (headers === undefined) return false;
  for (const [name, value] of Object.entries(headers))
    if (
      name.toLowerCase() === "content-type" &&
      isJsonMediaType(stringValue(value))
    )
      return true;
  return false;
};

export const isJsonMediaType = (value: string | null | undefined): boolean => {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
};

export const consolePrimitive = (
  value: UnknownRecord,
): { readonly type: string; readonly text: string } | undefined => {
  const type = stringValue(value.type);
  switch (type) {
    case "string":
      return typeof value.value === "string"
        ? { type, text: value.value }
        : undefined;
    case "boolean":
      return typeof value.value === "boolean"
        ? { type, text: String(value.value) }
        : undefined;
    case "number":
      return typeof value.value === "number"
        ? { type, text: String(value.value) }
        : typeof value.unserializableValue === "string"
          ? { type, text: value.unserializableValue }
          : undefined;
    case "bigint":
      return typeof value.unserializableValue === "string"
        ? { type, text: value.unserializableValue }
        : undefined;
    case "undefined":
      return { type, text: "undefined" };
    default:
      return undefined;
  }
};

const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

export const decodeBase64 = (value: string): Buffer | undefined =>
  value.length % 4 === 0 && BASE64.test(value)
    ? Buffer.from(value, "base64")
    : undefined;
