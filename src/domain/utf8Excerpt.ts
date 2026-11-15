/**
 * The last `maximumBytes` UTF-8 bytes of `text`, never splitting a character.
 * `bytes` is the excerpt's UTF-8 length; `truncated` says whether any of the
 * start of `text` was dropped.
 */
export const utf8TailExcerpt = (
  text: string,
  maximumBytes: number,
): {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maximumBytes)
    return { text, bytes: encoded.byteLength, truncated: false };
  let start = encoded.byteLength - Math.max(0, maximumBytes);
  // UTF-8 continuation bytes are 0b10xxxxxx; start at the next character.
  while (start < encoded.byteLength && ((encoded[start] ?? 0) & 0xc0) === 0x80)
    start += 1;
  const tail = encoded.subarray(start);
  return {
    text: tail.toString("utf8"),
    bytes: tail.byteLength,
    truncated: true,
  };
};
