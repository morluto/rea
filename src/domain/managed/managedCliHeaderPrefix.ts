import { BinaryReader } from "../binaryContainer.js";
import { err, ok } from "../result.js";

/** IMAGE_COR20_HEADER's first 16 bytes; consumers own directory/range admission. */
export const readManagedCliHeaderPrefix = (bytes: Buffer) => {
  if (bytes.length < 16)
    return err({
      kind: "malformed" as const,
      message: "CLI runtime header prefix is truncated",
    });
  const reader = new BinaryReader(bytes, true, "managed-pe");
  return ok({
    headerSize: reader.u32(0),
    runtimeMajor: reader.u16(4),
    runtimeMinor: reader.u16(6),
    metadata: {
      rva: reader.u32(8),
      size: reader.u32(12),
    },
  });
};
