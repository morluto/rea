const EMPTY_BUFFER = Buffer.alloc(0);

/** Byte-bounded head and tail diagnostics, decoded after stream chunks are joined. */
export class BoundedOutputExcerpt {
  readonly #headChunks: Buffer[] = [];
  #headBytes = 0;
  #tailRing: Buffer | undefined;
  #tailStart = 0;
  #tailLength = 0;
  // not-an-allowance: observed byte total, compared with the limit only to report truncation.
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
      this.#headLimit - this.#headBytes,
    );
    if (headCount > 0) {
      this.#headChunks.push(Buffer.from(chunk.subarray(0, headCount)));
      this.#headBytes += headCount;
    }
    const rest = chunk.subarray(headCount);
    if (rest.byteLength > 0 && this.#tailLimit > 0) this.#appendTail(rest);
  }

  #appendTail(rest: Buffer): void {
    const retained =
      rest.byteLength > this.#tailLimit
        ? rest.subarray(rest.byteLength - this.#tailLimit)
        : rest;
    const ring = (this.#tailRing ??= Buffer.allocUnsafe(this.#tailLimit));
    if (retained.byteLength === this.#tailLimit) {
      retained.copy(ring, 0);
      this.#tailStart = 0;
      this.#tailLength = this.#tailLimit;
      return;
    }
    const writeAt = (this.#tailStart + this.#tailLength) % this.#tailLimit;
    const firstWrite = Math.min(retained.byteLength, this.#tailLimit - writeAt);
    retained.copy(ring, writeAt, 0, firstWrite);
    if (firstWrite < retained.byteLength) retained.copy(ring, 0, firstWrite);
    const total = this.#tailLength + retained.byteLength;
    if (total <= this.#tailLimit) {
      this.#tailLength = total;
      return;
    }
    this.#tailStart =
      (this.#tailStart + (total - this.#tailLimit)) % this.#tailLimit;
    this.#tailLength = this.#tailLimit;
  }

  #headBuffer(): Buffer {
    if (this.#headBytes === 0) return EMPTY_BUFFER;
    return this.#headChunks.length === 1
      ? this.#headChunks[0]!
      : Buffer.concat(this.#headChunks, this.#headBytes);
  }

  #tailBuffer(): Buffer {
    if (this.#tailRing === undefined || this.#tailLength === 0)
      return EMPTY_BUFFER;
    if (this.#tailStart === 0)
      return this.#tailRing.subarray(0, this.#tailLength);
    const firstLen = Math.min(
      this.#tailLength,
      this.#tailLimit - this.#tailStart,
    );
    if (firstLen === this.#tailLength)
      return this.#tailRing.subarray(
        this.#tailStart,
        this.#tailStart + firstLen,
      );
    const joined = Buffer.allocUnsafe(this.#tailLength);
    this.#tailRing.copy(joined, 0, this.#tailStart, this.#tailStart + firstLen);
    this.#tailRing.copy(joined, firstLen, 0, this.#tailLength - firstLen);
    return joined;
  }

  get truncated(): boolean {
    return this.#total > this.limit;
  }

  get text(): string {
    const headBytes = this.#headBuffer();
    const tailBytes = this.#tailBuffer();
    if (!this.truncated)
      return Buffer.concat([headBytes, tailBytes]).toString("utf8");

    const head = decodeTruncatedHead(headBytes);
    let tailStart = 0;
    while (
      tailStart < tailBytes.length &&
      (tailBytes[tailStart]! & 0xc0) === 0x80
    )
      tailStart += 1;
    // A valid cut can leave at most three continuation bytes. Longer runs
    // are malformed output, so retain their decoding evidence.
    if (tailStart > 3) tailStart = 0;
    return `${head} … [output omitted] … ${tailBytes.subarray(tailStart).toString("utf8")}`;
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
