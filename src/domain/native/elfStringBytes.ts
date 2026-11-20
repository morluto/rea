import { observeElfStringTableEntry } from "../elfStringTable.js";
import {
  BinaryFormatFailure,
  binaryStringReadLimit,
} from "../binaryContainer.js";

/** Read exact string-table bytes; ELF does not prescribe a character encoding. */
export const readElfStringBytes = (bytes: Buffer, offset: number): Buffer => {
  const observed = observeElfStringTableEntry(bytes, offset, 65536);
  if (observed.state === "outside")
    throw new BinaryFormatFailure(
      "malformed",
      "ELF string offset is outside its string table",
    );
  if (observed.state === "truncated") {
    if (offset + observed.examinedBytes < bytes.length)
      throw binaryStringReadLimit(observed.examinedBytes);
    throw new BinaryFormatFailure(
      "malformed",
      "ELF string is unterminated inside its string table",
    );
  }
  return observed.bytes;
};
