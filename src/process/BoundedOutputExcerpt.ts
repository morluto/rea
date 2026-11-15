/** Byte-bounded head and tail diagnostics, decoded after stream chunks are joined. */
export class BoundedOutputExcerpt {
  #head: Buffer = Buffer.alloc(0);
  #tail: Buffer = Buffer.alloc(0);
  #total = 0;
  readonly #headLimit: number;
  readonly #tailLimit: number;

  constructor(readonly limit: number) {
    this.#headLimit = Math.ceil(limit / 2);
    this.#tailLimit = limit - this.#headLimit;
  }

  append(chunk: Buffer): void {
    this.#total += chunk.byteLength;
    const headCount = Math.min(
      chunk.byteLength,
      this.#headLimit - this.#head.byteLength,
    );
    if (headCount > 0)
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, headCount)]);
    const rest = chunk.subarray(headCount);
    if (rest.byteLength > 0 && this.#tailLimit > 0) {
      const retained = rest.subarray(-this.#tailLimit);
      this.#tail = Buffer.concat([
        this.#tail.subarray(
          Math.max(
            0,
            this.#tail.byteLength + retained.byteLength - this.#tailLimit,
          ),
        ),
        retained,
      ]);
    }
  }

  get truncated(): boolean {
    return this.#total > this.limit;
  }

  get text(): string {
    if (!this.truncated)
      return Buffer.concat([this.#head, this.#tail]).toString("utf8");

    const head = decodeTruncatedHead(this.#head);
    let tailStart = 0;
    while (
      tailStart < this.#tail.length &&
      (this.#tail[tailStart]! & 0xc0) === 0x80
    )
      tailStart += 1;
    // A valid cut can leave at most three continuation bytes. Longer runs
    // are malformed output, so retain their decoding evidence.
    if (tailStart > 3) tailStart = 0;
    return `${head} … [output omitted] … ${this.#tail.subarray(tailStart).toString("utf8")}`;
  }
}

/** Omit only a suffix that could still form a valid UTF-8 code point. */
const decodeTruncatedHead = (bytes: Buffer): string => {
  let start = bytes.length - 1;
  while (
    start >= 0 &&
    bytes.length - start < 4 &&
    (bytes[start]! & 0xc0) === 0x80
  )
    start -= 1;
  const first = bytes[start];
  if (first === undefined) return bytes.toString("utf8");
  const width =
    first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 0;
  const second = bytes[start + 1];
  // Exclude overlong encodings, surrogates and values beyond U+10FFFF.
  const minimumSecond = first === 0xe0 ? 0xa0 : first === 0xf0 ? 0x90 : 0x80;
  const maximumSecond = first === 0xed ? 0x9f : first === 0xf4 ? 0x8f : 0xbf;
  const incomplete =
    bytes.length - start < width &&
    (second === undefined ||
      (second >= minimumSecond && second <= maximumSecond));
  return bytes.toString("utf8", 0, incomplete ? start : bytes.length);
};
