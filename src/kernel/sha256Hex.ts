import { createHash } from "node:crypto";

/**
 * The lowercase hexadecimal SHA-256 digest of one in-memory value. A string is
 * hashed as UTF-8 unless `encoding` names another encoding. Incremental or
 * streamed hashing keeps its own `Hash`.
 */
export const sha256Hex = (
  data: string | NodeJS.ArrayBufferView,
  encoding?: BufferEncoding,
): string =>
  (typeof data === "string" && encoding !== undefined
    ? createHash("sha256").update(data, encoding)
    : createHash("sha256").update(data)
  ).digest("hex");
