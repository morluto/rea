import { StringDecoder } from "node:string_decoder";

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

    // Do not flush an incomplete code point at the cut edge of the head.
    const head = new StringDecoder("utf8").write(this.#head);
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
