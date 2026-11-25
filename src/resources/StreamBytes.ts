import { invariantViolation } from "../domain/internalInvariant.js";

/** Parse a Node readable chunk without unchecked coercion. */
export const streamChunkToBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  throw invariantViolation("Readable stream emitted a non-byte chunk");
};
