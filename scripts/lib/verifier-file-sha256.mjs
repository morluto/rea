import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Stream a verifier input into a lowercase hexadecimal SHA-256 digest.
 * @param {import("node:fs").PathLike} path
 */
export const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
