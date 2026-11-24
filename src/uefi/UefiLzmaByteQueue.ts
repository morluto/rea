import { Buffer } from "node:buffer";

export class UefiLzmaByteQueue {
  readonly #chunks: (Buffer | undefined)[] = [];
  #head = 0;
  #available = 0;

  get available(): number {
    return this.#available;
  }

  append(chunk: Buffer): boolean {
    if (chunk.length === 0) return false;
    this.#chunks.push(chunk);
    this.#available += chunk.length;
    return true;
  }

  /** Read a positive length after the caller has checked availability. */
  read(length: number): Buffer {
    const first = this.#chunks[this.#head]!;
    let result: Buffer;
    if (first.length === length) {
      result = first;
      this.#consumeHead();
    } else {
      result = this.#copy(length);
    }
    this.#available -= length;
    if (this.#available === 0) {
      this.#chunks.length = 0;
      this.#head = 0;
    } else if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks.splice(0, this.#head);
      this.#head = 0;
    }
    return result;
  }

  #copy(length: number): Buffer {
    const result = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const head = this.#chunks[this.#head]!;
      const take = Math.min(head.length, length - copied);
      head.copy(result, copied, 0, take);
      copied += take;
      if (take === head.length) {
        this.#consumeHead();
      } else {
        this.#chunks[this.#head] = head.subarray(take);
      }
    }
    return result;
  }

  #consumeHead(): void {
    this.#chunks[this.#head] = undefined;
    this.#head += 1;
  }
}
