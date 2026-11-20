import { err, ok, type Result } from "../result.js";

export interface SolcBytecodeObjectFacts {
  readonly byteLength: number;
  readonly placeholders: { start: number; length: number; value: string }[];
}

const isHex = (value: number | undefined): boolean =>
  value !== undefined &&
  ((value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x46) ||
    (value >= 0x61 && value <= 0x66));

/** Own bytecode offsets independently of the original object's text coordinates. */
export const inspectSolcBytecodeObject = (
  object: string,
): Result<SolcBytecodeObjectFacts, string> => {
  const encoded = Buffer.from(object, "utf8");
  if (encoded.toString("utf8") !== object)
    return err("Compiler bytecode object contains invalid Unicode text");
  const placeholders: SolcBytecodeObjectFacts["placeholders"] = [];
  for (let offset = 0; offset < encoded.length;) {
    if (isHex(encoded[offset]) && isHex(encoded[offset + 1])) {
      offset += 2;
      continue;
    }
    // Both generations reserve 40 representation bytes for a 20-byte address.
    const value = encoded.subarray(offset, offset + 40);
    const delimited =
      value.length === 40 &&
      value[0] === 0x5f &&
      value[1] === 0x5f &&
      value[38] === 0x5f &&
      value[39] === 0x5f;
    // Legacy opaque names can also have dollar delimiters; both remain unlinked.
    if (
      !delimited ||
      !value.subarray(2, 38).every((byte) => byte >= 0x20 && byte !== 0x7f)
    )
      return err(
        "Compiler bytecode contains malformed hex or link placeholders",
      );
    placeholders.push({
      start: offset / 2,
      length: 20,
      value: value.toString("utf8"),
    });
    offset += 40;
  }
  return ok({ byteLength: encoded.length / 2, placeholders });
};
