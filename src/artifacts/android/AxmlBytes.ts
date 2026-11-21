import type { AndroidManifestReadFailure } from "../../domain/android/androidManifestFacts.js";

/** Internal control flow: a typed failure raised while walking a document. */
export class Stop extends Error {
  constructor(readonly failure: AndroidManifestReadFailure) {
    super(failure.message);
  }
}
export const truncated = (message: string): Stop =>
  new Stop({ kind: "truncated", message });
export const malformed = (message: string): Stop =>
  new Stop({ kind: "malformed", message });
export const limit = (message: string): Stop =>
  new Stop({ kind: "limit_exceeded", message });

/** Bounds-checked little-endian cursor over one manifest document. */
export class Bytes {
  readonly #view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.byteLength;
  }
  u8(offset: number): number {
    if (offset < 0 || offset + 1 > this.length)
      throw truncated(`read of 1 byte at ${offset} exceeds ${this.length}`);
    return this.#view.getUint8(offset);
  }
  u16(offset: number): number {
    if (offset < 0 || offset + 2 > this.length)
      throw truncated(`read of 2 bytes at ${offset} exceeds ${this.length}`);
    return this.#view.getUint16(offset, true);
  }
  u32(offset: number): number {
    if (offset < 0 || offset + 4 > this.length)
      throw truncated(`read of 4 bytes at ${offset} exceeds ${this.length}`);
    return this.#view.getUint32(offset, true);
  }
}
