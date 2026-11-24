const jsonCharStep = (
  value: string,
  index: number,
): { readonly units: number; readonly bytes: number } => {
  const unit = value.charCodeAt(index);
  if (unit === 0x22 || unit === 0x5c) return { units: 1, bytes: 2 };
  if (unit < 0x20)
    return {
      units: 1,
      bytes:
        unit === 0x08 ||
        unit === 0x09 ||
        unit === 0x0a ||
        unit === 0x0c ||
        unit === 0x0d
          ? 2
          : 6,
    };
  if (unit < 0x80) return { units: 1, bytes: 1 };
  if (unit < 0x800) return { units: 1, bytes: 2 };
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { units: 2, bytes: 4 };
    return { units: 1, bytes: 6 };
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) return { units: 1, bytes: 6 };
  return { units: 1, bytes: 3 };
};

/** UTF-8 JSON string bytes without serialization; above budget only establishes overflow. */
export const jsonStringByteLength = (
  value: string,
  budget = Number.POSITIVE_INFINITY,
): number => {
  // Unescaped text has its native UTF-8 length. Stop before surrogate code
  // units so the bounded loop continues to distinguish pairs from lone units.
  let index = 0;
  let bytes = 2;
  if (value.length >= 1024 && value.length + 2 <= budget) {
    const prefixEnd =
      /["\\\u0000-\u001f\ud800-\udfff]/.exec(value)?.index ?? value.length;
    const prefixBytes = Buffer.byteLength(
      prefixEnd === value.length ? value : value.slice(0, prefixEnd),
      "utf8",
    );
    if (prefixBytes + 2 <= budget) {
      index = prefixEnd;
      bytes = prefixBytes + 2;
    }
  }
  while (index < value.length && bytes <= budget) {
    const step = jsonCharStep(value, index);
    bytes += step.bytes;
    index += step.units;
  }
  return bytes;
};

/** Truncate text at a safe code-point boundary so JSON serialization fits within maxJsonBytes. */
export const truncateJsonString = (
  value: string,
  maxJsonBytes: number,
  suffix = "",
): string => {
  if (maxJsonBytes <= 2) return "";
  if (jsonStringByteLength(value, maxJsonBytes) <= maxJsonBytes) return value;
  const suffixPayloadBytes = jsonStringByteLength(suffix, maxJsonBytes) - 2;
  if (2 + suffixPayloadBytes > maxJsonBytes)
    return truncateJsonString(suffix, maxJsonBytes);
  const prefixPayloadLimit = maxJsonBytes - 2 - suffixPayloadBytes;
  let index = 0;
  let payloadBytes = 0;
  while (index < value.length) {
    const step = jsonCharStep(value, index);
    if (payloadBytes + step.bytes > prefixPayloadLimit) break;
    payloadBytes += step.bytes;
    index += step.units;
  }
  return `${value.slice(0, index)}${suffix}`;
};
