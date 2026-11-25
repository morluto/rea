import { excerptText, type ExcerptText } from "./excerpt.js";

/**
 * The last `maximumBytes` UTF-8 bytes of `text`, never splitting a character.
 * `bytes` is the excerpt's UTF-8 length; `truncated` says whether any of the
 * start of `text` was dropped.
 */
export const utf8TailExcerpt = (
  text: string,
  maximumBytes: number,
): {
  readonly text: ExcerptText;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  // A UTF-16 suffix needs at least one UTF-8 byte per code unit.
  // Include one extra unit so the candidate cannot cut a surrogate pair
  // that would fit in the result.
  const candidateStart = Math.max(0, text.length - Math.ceil(maximumBytes) - 1);
  const encoded = Buffer.from(text.slice(candidateStart), "utf8");
  if (candidateStart === 0 && encoded.byteLength <= maximumBytes)
    return {
      text: excerptText(text),
      bytes: encoded.byteLength,
      truncated: false,
    };
  let start = Math.max(
    0,
    encoded.byteLength - Math.max(0, Math.floor(maximumBytes)),
  );
  // UTF-8 continuation bytes are 0b10xxxxxx; start at the next character.
  while (start < encoded.byteLength && ((encoded[start] ?? 0) & 0xc0) === 0x80)
    start += 1;
  const tail = encoded.subarray(start);
  return {
    text: excerptText(tail.toString("utf8")),
    bytes: tail.byteLength,
    truncated: true,
  };
};
