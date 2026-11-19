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
  for (; index < value.length && bytes <= budget; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit < 0x20)
      bytes +=
        unit === 0x08 ||
        unit === 0x09 ||
        unit === 0x0a ||
        unit === 0x0c ||
        unit === 0x0d
          ? 2
          : 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
};
